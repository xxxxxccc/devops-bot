/**
 * Embedding Provider — local-first with optional remote fallback.
 *
 * Default: node-llama-cpp + embeddinggemma-300M (768 dims, ~0.6GB model).
 * Fallback: OpenAI text-embedding-3-small (1536 dims) if OPENAI_API_KEY set.
 *
 * All vectors are L2-normalized before storage.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../infra/logger.js'
import type { MemoryDatabase } from './db.js'

const log = createLogger('embedding')
const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const MODELS_DIR = join(PROJECT_ROOT, 'models')

/* ------------------------------------------------------------------ */
/*  Interface                                                          */
/* ------------------------------------------------------------------ */

export interface EmbeddingProvider {
  /** Model name used (for cache isolation) */
  readonly model: string
  /** Vector dimensions produced */
  readonly dimensions: number
  /** Generate embedding for a single text */
  embedQuery(text: string): Promise<number[]>
  /** Generate embeddings for a batch of texts */
  embedBatch(texts: string[]): Promise<number[][]>
}

/* ------------------------------------------------------------------ */
/*  L2 normalization                                                   */
/* ------------------------------------------------------------------ */

/** Normalize a vector to unit length, sanitizing non-finite values */
function normalizeL2(vec: number[]): number[] {
  const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0))
  const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) return sanitized
  return sanitized.map((v) => v / magnitude)
}

/* ------------------------------------------------------------------ */
/*  Local Provider (node-llama-cpp)                                    */
/* ------------------------------------------------------------------ */

const LOCAL_MODEL_PATH = 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf'
const LOCAL_DIMENSIONS = 768

/**
 * Import node-llama-cpp with fallback resolution.
 *
 * Bun's module resolver sometimes fails to find packages installed via
 * `bun add` (especially after git pull overwrites package.json).
 * If the standard `import()` fails, we fall back to importing from the
 * known absolute path in node_modules.
 */
async function importNodeLlamaCpp(): Promise<typeof import('node-llama-cpp')> {
  // Standard resolution
  try {
    return await import('node-llama-cpp')
  } catch {
    // Fall through to absolute path resolution
  }

  // Fallback: resolve from known node_modules location
  const pkgDir = join(PROJECT_ROOT, 'node_modules', 'node-llama-cpp')
  const pkgJsonPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`node-llama-cpp is not installed (not found at ${pkgDir})`)
  }

  // Read entry point from package.json exports/main
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const exports = pkgJson.exports?.['.']
  let entryPoint: string
  if (typeof exports === 'string') {
    entryPoint = exports
  } else if (exports?.import) {
    entryPoint = typeof exports.import === 'string' ? exports.import : exports.import.default
  } else {
    entryPoint = pkgJson.main ?? 'index.js'
  }

  const absoluteEntry = join(pkgDir, entryPoint)
  log.info(`Fallback import from ${absoluteEntry}`)
  return await import(absoluteEntry)
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'embeddinggemma-300M'
  readonly dimensions = LOCAL_DIMENSIONS
  private context: import('node-llama-cpp').LlamaEmbeddingContext | null = null
  private initPromise: Promise<void> | null = null

  private async ensureContext(): Promise<void> {
    if (this.context) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    this.initPromise = this.loadModel()
    await this.initPromise
  }

  private async loadModel(): Promise<void> {
    try {
      const llamaModule = await importNodeLlamaCpp()
      const { getLlama, LlamaLogLevel, resolveModelFile } = llamaModule

      log.info('Initializing local embedding model...')
      const llama = await getLlama({ logLevel: LlamaLogLevel.error })
      // Resolve from project-local models/ dir; auto-downloads from HF if not found
      const modelPath = await resolveModelFile(LOCAL_MODEL_PATH, MODELS_DIR)
      const model = await llama.loadModel({ modelPath })
      this.context = await model.createEmbeddingContext()
      log.info('Local embedding model ready')
    } catch (err) {
      this.context = null
      this.initPromise = null
      throw err
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    await this.ensureContext()
    const result = await this.context!.getEmbeddingFor(text)
    return normalizeL2(Array.from(result.vector))
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureContext()
    const results: number[][] = []
    for (const text of texts) {
      const result = await this.context!.getEmbeddingFor(text)
      results.push(normalizeL2(Array.from(result.vector)))
    }
    return results
  }
}

/* ------------------------------------------------------------------ */
/*  Remote Provider (OpenAI)                                           */
/* ------------------------------------------------------------------ */

const OPENAI_MODEL = 'text-embedding-3-small'
const OPENAI_DIMENSIONS = 1536

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = OPENAI_MODEL
  readonly dimensions = OPENAI_DIMENSIONS
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async embedQuery(text: string): Promise<number[]> {
    const results = await this.callAPI([text])
    return results[0]
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // OpenAI supports batch up to 2048 inputs
    const batchSize = 256
    const allResults: number[][] = []
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const results = await this.callAPI(batch)
      allResults.push(...results)
    }
    return allResults
  }

  private async callAPI(inputs: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${text}`)
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>
    }

    // Sort by index (API may return out of order)
    return data.data.sort((a, b) => a.index - b.index).map((d) => normalizeL2(d.embedding))
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create the best available embedding provider.
 *
 * Strategy:
 * 1. Try local (node-llama-cpp) — free, no API key needed
 * 2. Try OpenAI — if OPENAI_API_KEY is set
 * 3. Return null — embeddings unavailable, system degrades to keyword search
 */
/** Check whether models/ directory has downloaded model files */
function hasModelFiles(): boolean {
  if (!existsSync(MODELS_DIR)) return false
  try {
    return readdirSync(MODELS_DIR).length > 0
  } catch {
    return false
  }
}

/** Check if an error indicates the npm package is simply not installed */
function isPackageMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('Cannot find package') ||
    msg.includes('Cannot find module') ||
    msg.includes('MODULE_NOT_FOUND') ||
    msg.includes('Cannot resolve')
  )
}

export async function createEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  // Try local first
  try {
    const local = new LocalEmbeddingProvider()
    // Verify it works by doing a test embed
    await local.embedQuery('test')
    log.info('Using local embedding provider (embeddinggemma-300M)')
    return local
  } catch (err) {
    if (isPackageMissing(err)) {
      // node-llama-cpp not installed
      if (hasModelFiles()) {
        // User ran setup-embedding before but the package got removed (e.g. by upgrade)
        log.warn(
          'Embedding model found but node-llama-cpp is missing — run `devops-bot setup-embedding` or `devops-bot upgrade` to fix',
        )
      }
      // Otherwise: user never set it up — stay silent
    } else {
      // Real loading error (model corruption, GPU driver issue, etc.)
      log.warn('Local embedding failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Try OpenAI
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    try {
      const openai = new OpenAIEmbeddingProvider(openaiKey)
      log.info('Using OpenAI embedding provider (text-embedding-3-small)')
      return openai
    } catch (err) {
      log.warn('OpenAI embedding failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!hasModelFiles()) {
    log.info('Vector search disabled (run `devops-bot setup-embedding` to enable)')
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  Cached embedding helper                                            */
/* ------------------------------------------------------------------ */

/**
 * Get or compute an embedding, using the database embedding cache.
 */
export async function getOrComputeEmbedding(
  contentHash: string,
  text: string,
  provider: EmbeddingProvider,
  db: MemoryDatabase,
): Promise<number[]> {
  // Check cache first
  const cached = db.getCachedEmbedding(contentHash)
  if (cached) return cached

  // Compute and cache
  const embedding = await provider.embedQuery(text)
  db.setCachedEmbedding(contentHash, embedding, provider.model)
  return embedding
}

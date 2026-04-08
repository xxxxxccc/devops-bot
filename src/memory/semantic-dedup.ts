/**
 * Semantic Deduplication — LLM-driven decision cycle.
 *
 * When hash-based dedup misses (new text, same meaning),
 * this module searches for semantically similar memories and asks
 * an LLM to decide: ADD, UPDATE, NOOP, or DELETE.
 *
 * Inspired by mem0's memory action decision cycle.
 */

import type { AIProvider } from '../providers/types.js'
import { getModelRouter } from '../providers/router.js'
import { createLogger } from '../infra/logger.js'
import type { MemorySearchResult } from './types.js'

const log = createLogger('semantic-dedup')

const MEMORY_MODEL = process.env.MEMORY_MODEL || 'claude-haiku-4-5-20251001'
const SEMANTIC_DEDUP_ENABLED = process.env.MEMORY_SEMANTIC_DEDUP !== 'false'
const SEMANTIC_DEDUP_MIN_SCORE = parseFloat(process.env.MEMORY_SEMANTIC_DEDUP_MIN_SCORE || '0.35')
const SEMANTIC_DEDUP_TOP_K = parseInt(process.env.MEMORY_SEMANTIC_DEDUP_TOP_K || '5', 10)

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SemanticAction =
  | { action: 'add' }
  | { action: 'update'; targetId: string; mergedContent: string }
  | { action: 'noop'; targetId: string }
  | { action: 'delete'; targetId: string }

/* ------------------------------------------------------------------ */
/*  Provider cache                                                     */
/* ------------------------------------------------------------------ */

let cachedProvider: AIProvider | null = null
let cachedModelId: string = MEMORY_MODEL

async function getProvider(): Promise<AIProvider> {
  if (!cachedProvider) {
    const route = await getModelRouter().resolve(MEMORY_MODEL)
    cachedProvider = route.provider
    cachedModelId = route.modelId
  }
  return cachedProvider
}

function stripFences(text: string): string {
  return text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
}

/* ------------------------------------------------------------------ */
/*  Core                                                               */
/* ------------------------------------------------------------------ */

/**
 * Run semantic deduplication against existing memories.
 *
 * @param newContent   The content of the new memory
 * @param newType      The type of the new memory
 * @param candidates   Pre-fetched similar memories from hybrid search
 * @returns            Decision on what to do with the new memory
 */
export async function semanticDedup(
  newContent: string,
  newType: string,
  candidates: MemorySearchResult[],
): Promise<SemanticAction> {
  if (!SEMANTIC_DEDUP_ENABLED) return { action: 'add' }
  if (candidates.length === 0) return { action: 'add' }

  const existing = candidates
    .map(
      (c, i) =>
        `${i + 1}. [id=${c.item.id}] [${c.item.type}] ${c.item.content.slice(0, 200)} (score=${c.score.toFixed(3)}, reinforced=${c.item.reinforcementCount || 1}x)`,
    )
    .join('\n')

  const prompt = `Compare a new memory against existing ones and decide ONE action.

New memory:
[${newType}] ${newContent}

Existing similar memories:
${existing}

Actions:
- ADD: The new memory is genuinely different from all existing ones.
- UPDATE <id>: The new memory refines or extends an existing one. Provide merged content that combines both.
- NOOP <id>: The new memory means the same thing as an existing one. Just reinforce it.
- DELETE <id>: The new memory contradicts or invalidates an existing one. Remove the old, keep the new.

Respond with ONLY a JSON object (no markdown):
{"action":"ADD"} or
{"action":"UPDATE","targetId":"<id>","mergedContent":"<merged text>"} or
{"action":"NOOP","targetId":"<id>"} or
{"action":"DELETE","targetId":"<id>"}`

  try {
    const provider = await getProvider()
    const response = await provider.createMessage({
      model: cachedModelId,
      maxTokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')

    const parsed = JSON.parse(stripFences(text)) as Record<string, string>
    const action = parsed.action?.toUpperCase()

    switch (action) {
      case 'UPDATE':
        if (parsed.targetId && parsed.mergedContent) {
          return {
            action: 'update',
            targetId: parsed.targetId,
            mergedContent: parsed.mergedContent,
          }
        }
        break
      case 'NOOP':
        if (parsed.targetId) {
          return { action: 'noop', targetId: parsed.targetId }
        }
        break
      case 'DELETE':
        if (parsed.targetId) {
          return { action: 'delete', targetId: parsed.targetId }
        }
        break
      case 'ADD':
        return { action: 'add' }
    }

    // Unrecognized or incomplete response — fall back to ADD
    log.debug('Semantic dedup: unrecognized response, defaulting to ADD', {
      response: text.slice(0, 200),
    })
    return { action: 'add' }
  } catch (err) {
    log.warn('Semantic dedup LLM call failed, defaulting to ADD', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { action: 'add' }
  }
}

/** Configuration getters for use by store.ts */
export const semanticDedupConfig = {
  enabled: SEMANTIC_DEDUP_ENABLED,
  minScore: SEMANTIC_DEDUP_MIN_SCORE,
  topK: SEMANTIC_DEDUP_TOP_K,
} as const

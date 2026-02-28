/**
 * Memory Database — cross-runtime SQLite wrapper.
 *
 * Supports both:
 * - **Bun**: uses built-in `bun:sqlite` (zero deps)
 * - **Node.js**: uses `better-sqlite3` (native addon)
 *
 * The APIs are nearly identical — prepare/run/get/all/exec/close/transaction.
 * sqlite-vec extension loading works via `.loadExtension()` on both.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../infra/logger.js'
import type { MemoryItem, MemoryType } from './types.js'

const log = createLogger('memory-db')

/** Runtime detection */
const IS_BUN = 'Bun' in globalThis

/** All valid memory types (each maps to a .jsonl export) */
const MEMORY_TYPES: MemoryType[] = [
  'decision',
  'context',
  'preference',
  'issue',
  'task_input',
  'task_result',
]

/* ------------------------------------------------------------------ */
/*  Cross-runtime SQLite database opener                               */
/* ------------------------------------------------------------------ */

/**
 * Open a SQLite database using the appropriate driver for the runtime.
 * Returns a database object with compatible API (prepare/exec/close/etc).
 */
async function openDatabase(dbPath: string): Promise<any> {
  if (IS_BUN) {
    // Dynamic string prevents tsc from resolving bun:sqlite at compile time
    const bunModule = 'bun:sqlite'
    const { Database } = await import(bunModule)
    return new Database(dbPath)
  }
  const { default: Database } = await import('better-sqlite3')
  return new Database(dbPath)
}

/* ------------------------------------------------------------------ */
/*  Schema SQL                                                         */
/* ------------------------------------------------------------------ */

const SCHEMA_SQL = `
-- Core storage
CREATE TABLE IF NOT EXISTS memory_items (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL,
  content              TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  source               TEXT NOT NULL,
  source_id            TEXT,
  project_path         TEXT NOT NULL,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  reinforcement_count  INTEGER NOT NULL DEFAULT 1,
  last_reinforced_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_hash    ON memory_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_items_type    ON memory_items(type);
CREATE INDEX IF NOT EXISTS idx_items_project ON memory_items(project_path);

-- Embedding cache (avoid re-computing identical content)
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash  TEXT PRIMARY KEY,
  embedding     BLOB NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id,
  content,
  type,
  created_by,
  content='memory_items',
  content_rowid='rowid'
);
`

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MemoryItemRow {
  id: string
  type: string
  content: string
  content_hash: string
  source: string
  source_id: string | null
  project_path: string
  created_by: string | null
  created_at: string
  reinforcement_count: number
  last_reinforced_at: string | null
}

export interface EmbeddingCacheRow {
  content_hash: string
  embedding: Buffer
  model: string
  created_at: string
}

/* ------------------------------------------------------------------ */
/*  Database class                                                     */
/* ------------------------------------------------------------------ */

export class MemoryDatabase {
  private db: any
  private vectorAvailable = false
  private vectorDimensions = 0

  private constructor(db: any) {
    this.db = db
  }

  /**
   * Create and initialize a MemoryDatabase.
   * Detects runtime (Bun vs Node.js) and uses the appropriate SQLite driver.
   */
  static async create(dbPath: string): Promise<MemoryDatabase> {
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const rawDb = await openDatabase(dbPath)
    const instance = new MemoryDatabase(rawDb)
    // Use exec() for PRAGMAs — works in both runtimes
    instance.db.exec('PRAGMA journal_mode = WAL')
    instance.db.exec('PRAGMA foreign_keys = ON')
    instance.initSchema()
    log.info(`SQLite opened (${IS_BUN ? 'bun:sqlite' : 'better-sqlite3'})`)
    return instance
  }

  /* ---------------------------------------------------------------- */
  /*  Schema                                                           */
  /* ---------------------------------------------------------------- */

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL)
    // FTS5 — might fail if SQLite was compiled without FTS5
    try {
      this.db.exec(FTS_SQL)
    } catch (err) {
      log.warn('FTS5 unavailable, keyword search disabled', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Load sqlite-vec extension and create vector virtual table.
   * Call this after embedding dimensions are known.
   *
   * sqlite-vec's load() internally calls db.loadExtension() which
   * works on both bun:sqlite and better-sqlite3.
   */
  async loadVectorExtension(dimensions: number): Promise<boolean> {
    if (this.vectorAvailable) return true
    try {
      const sqliteVec = await import('sqlite-vec')
      // sqlite-vec is CJS — Bun exposes .load directly, Node wraps it in .default
      const loadFn = (sqliteVec as any).default?.load ?? (sqliteVec as any).load
      if (typeof loadFn !== 'function') {
        throw new Error('sqlite-vec module has no load() export')
      }
      loadFn(this.db)
      this.createVectorTable(dimensions)
      this.vectorAvailable = true
      this.vectorDimensions = dimensions
      log.info(`sqlite-vec loaded (${dimensions} dimensions)`)
      return true
    } catch (err) {
      log.warn('sqlite-vec unavailable, vector search disabled', {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  private createVectorTable(dimensions: number): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${dimensions}]
        )
      `)
    } catch {
      // Table exists with different dimensions — recreate
      this.db.exec('DROP TABLE IF EXISTS memory_vec')
      this.db.exec(`
        CREATE VIRTUAL TABLE memory_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${dimensions}]
        )
      `)
    }
  }

  get isVectorAvailable(): boolean {
    return this.vectorAvailable
  }

  get dimensions(): number {
    return this.vectorDimensions
  }

  /* ---------------------------------------------------------------- */
  /*  Memory item CRUD                                                 */
  /* ---------------------------------------------------------------- */

  insertItem(item: MemoryItemRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_items
        (id, type, content, content_hash, source, source_id, project_path,
         created_by, created_at, reinforcement_count, last_reinforced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      item.id,
      item.type,
      item.content,
      item.content_hash,
      item.source,
      item.source_id,
      item.project_path,
      item.created_by,
      item.created_at,
      item.reinforcement_count,
      item.last_reinforced_at,
    )
    this.syncFtsInsert(item)
  }

  getItemByHash(contentHash: string, projectPath: string): MemoryItemRow | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM memory_items WHERE content_hash = ? AND project_path = ?',
    )
    return stmt.get(contentHash, projectPath) as MemoryItemRow | undefined
  }

  getItem(id: string): MemoryItemRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM memory_items WHERE id = ?')
    return stmt.get(id) as MemoryItemRow | undefined
  }

  updateReinforcement(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE memory_items
      SET reinforcement_count = reinforcement_count + 1,
          last_reinforced_at = ?
      WHERE id = ?
    `)
    stmt.run(new Date().toISOString(), id)
  }

  getAllItems(projectPath: string): MemoryItemRow[] {
    const stmt = this.db.prepare('SELECT * FROM memory_items WHERE project_path = ?')
    return stmt.all(projectPath) as MemoryItemRow[]
  }

  getItemsByType(type: string, projectPath: string): MemoryItemRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM memory_items WHERE type = ? AND project_path = ? ORDER BY created_at DESC',
    )
    return stmt.all(type, projectPath) as MemoryItemRow[]
  }

  getItemCount(projectPath: string): number {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM memory_items WHERE project_path = ?',
    )
    return (stmt.get(projectPath) as { count: number }).count
  }

  /** Total items across all projects (used for migration check) */
  getTotalItemCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memory_items')
    return (stmt.get() as { count: number }).count
  }

  /** Get all items across all projects (used for embedding backfill) */
  getAllItemsAcrossProjects(): MemoryItemRow[] {
    const stmt = this.db.prepare('SELECT * FROM memory_items')
    return stmt.all() as MemoryItemRow[]
  }

  /* ---------------------------------------------------------------- */
  /*  FTS sync                                                         */
  /* ---------------------------------------------------------------- */

  private syncFtsInsert(item: MemoryItemRow): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO memory_fts(id, content, type, created_by) VALUES (?, ?, ?, ?)',
      )
      stmt.run(item.id, item.content, item.type, item.created_by || '')
    } catch {
      // FTS unavailable
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Vector operations                                                */
  /* ---------------------------------------------------------------- */

  insertVector(id: string, embedding: number[]): void {
    if (!this.vectorAvailable) return
    try {
      const blob = vectorToBlob(embedding)
      const stmt = this.db.prepare('INSERT OR REPLACE INTO memory_vec(id, embedding) VALUES (?, ?)')
      stmt.run(id, blob)
    } catch (err) {
      log.warn(`Failed to insert vector for ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Search by vector cosine distance.
   * Returns items sorted by ascending distance (closest first).
   *
   * Strategy:
   * 1. If sqlite-vec available → native SQL vector search (fast, scalable)
   * 2. Otherwise → in-memory brute-force from embedding_cache (works everywhere)
   */
  vectorSearch(
    embedding: number[],
    projectPath: string,
    limit: number,
  ): Array<{ id: string; distance: number }> {
    if (this.vectorAvailable) {
      try {
        const blob = vectorToBlob(embedding)
        const stmt = this.db.prepare(`
          SELECT v.id, vec_distance_cosine(v.embedding, ?) AS distance
          FROM memory_vec v
          JOIN memory_items m ON m.id = v.id
          WHERE m.project_path = ?
          ORDER BY distance ASC
          LIMIT ?
        `)
        return stmt.all(blob, projectPath, limit) as Array<{ id: string; distance: number }>
      } catch (err) {
        log.warn('Native vector search failed, falling back to in-memory', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Fallback: brute-force cosine distance from embedding_cache
    return this.inMemoryVectorSearch(embedding, projectPath, limit)
  }

  /**
   * In-memory brute-force vector search using embedding_cache table.
   * Reads all cached embeddings for the project and computes cosine distance.
   * Performance: ~0.3ms for 300 items × 768 dims on modern hardware.
   */
  private inMemoryVectorSearch(
    queryEmbedding: number[],
    projectPath: string,
    limit: number,
  ): Array<{ id: string; distance: number }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, e.embedding
           FROM memory_items m
           JOIN embedding_cache e ON e.content_hash = m.content_hash
           WHERE m.project_path = ?`,
        )
        .all(projectPath) as Array<{ id: string; embedding: Buffer }>

      if (rows.length === 0) return []

      // Compute cosine distance for each item
      const scored = rows.map((row) => ({
        id: row.id,
        distance: cosineDistance(queryEmbedding, blobToVector(row.embedding)),
      }))

      // Sort ascending (closest first) and take top-K
      scored.sort((a, b) => a.distance - b.distance)
      return scored.slice(0, limit)
    } catch (err) {
      log.warn('In-memory vector search failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  /**
   * FTS5 BM25 keyword search.
   * Returns items sorted by relevance (ascending rank = more relevant).
   */
  keywordSearch(
    query: string,
    projectPath: string,
    limit: number,
  ): Array<{ id: string; rank: number }> {
    try {
      // Sanitize FTS query: wrap each word in quotes to avoid syntax errors
      const terms = query
        .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"`)
        .join(' OR ')
      if (!terms) return []

      const stmt = this.db.prepare(`
        SELECT f.id, bm25(memory_fts) AS rank
        FROM memory_fts f
        JOIN memory_items m ON m.id = f.id
        WHERE memory_fts MATCH ? AND m.project_path = ?
        ORDER BY rank ASC
        LIMIT ?
      `)
      return stmt.all(terms, projectPath, limit) as Array<{ id: string; rank: number }>
    } catch (err) {
      log.warn('Keyword search failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Embedding cache                                                  */
  /* ---------------------------------------------------------------- */

  getCachedEmbedding(contentHash: string): number[] | null {
    const stmt = this.db.prepare('SELECT embedding FROM embedding_cache WHERE content_hash = ?')
    const row = stmt.get(contentHash) as { embedding: Buffer } | undefined
    if (!row) return null
    return blobToVector(row.embedding)
  }

  setCachedEmbedding(contentHash: string, embedding: number[], model: string): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO embedding_cache(content_hash, embedding, model, created_at) VALUES (?, ?, ?, ?)',
    )
    stmt.run(contentHash, vectorToBlob(embedding), model, new Date().toISOString())
  }

  /* ---------------------------------------------------------------- */
  /*  JSONL export (for AI file browsing)                              */
  /* ---------------------------------------------------------------- */

  /**
   * Export all memory items to per-type JSONL files.
   * Layer 2 AI can `read_file data/memory/decision.jsonl` to browse.
   */
  exportToJsonl(memoryRoot: string): void {
    for (const type of MEMORY_TYPES) {
      const items = this.db
        .prepare('SELECT * FROM memory_items WHERE type = ? ORDER BY created_at ASC')
        .all(type) as MemoryItemRow[]

      const lines = items
        .map((row: MemoryItemRow) => JSON.stringify(rowToMemoryItem(row)))
        .join('\n')
      const filePath = join(memoryRoot, `${type}.jsonl`)
      writeFileSync(filePath, lines ? `${lines}\n` : '', 'utf-8')
    }
    log.debug(`Exported JSONL files to ${memoryRoot}`)
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  close(): void {
    this.db.close()
  }

  /** Run a batch of operations in a transaction */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Convert number[] to Float32Array Buffer for sqlite-vec */
export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

/** Convert sqlite-vec BLOB back to number[] */
export function blobToVector(blob: Buffer): number[] {
  const float32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
  return Array.from(float32)
}

/**
 * Cosine distance between two L2-normalized vectors.
 * For normalized vectors: distance = 1 - dot_product.
 * Returns 0 for identical vectors, 2 for opposite.
 */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return 1 - dot
}

/** Convert a database row to a MemoryItem interface */
export function rowToMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    type: row.type as MemoryType,
    content: row.content,
    contentHash: row.content_hash,
    source: row.source as MemoryItem['source'],
    sourceId: row.source_id || '',
    projectPath: row.project_path,
    createdBy: row.created_by || undefined,
    createdAt: row.created_at,
    reinforcementCount: row.reinforcement_count,
    lastReinforcedAt: row.last_reinforced_at || undefined,
  }
}

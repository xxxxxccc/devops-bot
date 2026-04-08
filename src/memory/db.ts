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
import type { MemoryItem, MemoryNamespace, MemoryType } from './types.js'

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
  'review_feedback',
  'review_pattern',
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

const WORKING_MEMORY_SQL = `
CREATE TABLE IF NOT EXISTS working_memory (
  chat_id     TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  model_id    TEXT,
  updated_at  TEXT NOT NULL
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

const HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS memory_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  old_content TEXT,
  new_content TEXT,
  old_hash    TEXT,
  new_hash    TEXT,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memory_id);
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
  namespace: string
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

export interface MemoryHistoryRow {
  id: number
  memory_id: string
  action: 'created' | 'updated' | 'deleted'
  old_content: string | null
  new_content: string | null
  old_hash: string | null
  new_hash: string | null
  changed_at: string
  changed_by: string | null
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

  /** Expose the raw SQLite database handle for shared use (e.g. project registry). */
  getRawDatabase(): any {
    return this.db
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
    this.db.exec(WORKING_MEMORY_SQL)
    this.migrateNamespace()
    this.migrateUpdatedAt()
    // FTS5 — might fail if SQLite was compiled without FTS5
    try {
      this.db.exec(FTS_SQL)
    } catch (err) {
      log.warn('FTS5 unavailable, keyword search disabled', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // History table for audit trail
    try {
      this.db.exec(HISTORY_SQL)
    } catch (err) {
      log.warn('History table creation failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Add namespace column if missing (migration for existing databases). */
  private migrateNamespace(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info('memory_items')").all() as Array<{
        name: string
      }>
      const hasNamespace = cols.some((c) => c.name === 'namespace')
      if (!hasNamespace) {
        this.db.exec("ALTER TABLE memory_items ADD COLUMN namespace TEXT NOT NULL DEFAULT 'task'")
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_items_namespace ON memory_items(namespace)')
        log.info('Migrated memory_items: added namespace column')
      }
    } catch (err) {
      log.warn('Namespace migration check failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Add updated_at column if missing (migration for existing databases). */
  private migrateUpdatedAt(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info('memory_items')").all() as Array<{
        name: string
      }>
      if (!cols.some((c) => c.name === 'updated_at')) {
        this.db.exec('ALTER TABLE memory_items ADD COLUMN updated_at TEXT')
        log.info('Migrated memory_items: added updated_at column')
      }
    } catch (err) {
      log.warn('updated_at migration check failed', {
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
  /*  History audit                                                    */
  /* ---------------------------------------------------------------- */

  /** Write an audit record to memory_history. */
  private insertHistory(
    memoryId: string,
    action: 'created' | 'updated' | 'deleted',
    oldContent: string | null,
    newContent: string | null,
    oldHash: string | null,
    newHash: string | null,
    changedBy?: string | null,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_history
             (memory_id, action, old_content, new_content, old_hash, new_hash, changed_at, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memoryId,
          action,
          oldContent,
          newContent,
          oldHash,
          newHash,
          new Date().toISOString(),
          changedBy ?? null,
        )
    } catch {
      // history table unavailable — non-critical
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Memory item CRUD                                                 */
  /* ---------------------------------------------------------------- */

  insertItem(item: MemoryItemRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_items
        (id, type, content, content_hash, source, source_id, project_path,
         namespace, created_by, created_at, reinforcement_count, last_reinforced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      item.id,
      item.type,
      item.content,
      item.content_hash,
      item.source,
      item.source_id,
      item.project_path,
      item.namespace || 'task',
      item.created_by,
      item.created_at,
      item.reinforcement_count,
      item.last_reinforced_at,
    )
    this.syncFtsInsert(item)
    this.insertHistory(
      item.id,
      'created',
      null,
      item.content,
      null,
      item.content_hash,
      item.created_by,
    )
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

  /** Update memory content with full audit trail + FTS/vector re-index. */
  updateItemContent(
    id: string,
    newContent: string,
    newHash: string,
    changedBy?: string,
  ): MemoryItemRow | undefined {
    const old = this.getItem(id)
    if (!old) return undefined
    this.insertHistory(id, 'updated', old.content, newContent, old.content_hash, newHash, changedBy)
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE memory_items
         SET content = ?, content_hash = ?, updated_at = ?,
             reinforcement_count = reinforcement_count + 1,
             last_reinforced_at = ?
         WHERE id = ?`,
      )
      .run(newContent, newHash, now, now, id)
    // Re-sync FTS: delete old entry, insert new
    this.syncFtsDelete(old)
    const updated = this.getItem(id)!
    this.syncFtsInsert(updated)
    // Clear old vector (caller will re-embed)
    this.deleteVector(id)
    // Clear stale embedding cache only if no other items still reference the old hash
    if (old.content_hash !== newHash) {
      try {
        const refCount = (
          this.db
            .prepare('SELECT COUNT(*) as cnt FROM memory_items WHERE content_hash = ?')
            .get(old.content_hash) as { cnt: number }
        ).cnt
        if (refCount === 0) {
          this.db
            .prepare('DELETE FROM embedding_cache WHERE content_hash = ?')
            .run(old.content_hash)
        }
      } catch {
        // cache cleanup non-critical
      }
    }
    return updated
  }

  /** Delete a memory item with audit trail. */
  deleteItem(id: string, changedBy?: string): boolean {
    const item = this.getItem(id)
    if (!item) return false
    this.insertHistory(id, 'deleted', item.content, null, item.content_hash, null, changedBy)
    this.syncFtsDelete(item)
    this.deleteVector(id)
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id)
    return true
  }

  /** Get change history for a memory item. */
  getHistory(memoryId: string): MemoryHistoryRow[] {
    try {
      return this.db
        .prepare('SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id ASC')
        .all(memoryId) as MemoryHistoryRow[]
    } catch {
      return []
    }
  }

  /** Get stale memory candidates for pruning. */
  getStaleCandidates(
    projectPath: string,
    maxAgeDays: number,
    minReinforcement: number,
  ): MemoryItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE project_path = ?
           AND reinforcement_count < ?
           AND julianday('now') - julianday(created_at) > ?
           AND (last_reinforced_at IS NULL OR julianday('now') - julianday(last_reinforced_at) > ?)
         ORDER BY reinforcement_count ASC, created_at ASC`,
      )
      .all(projectPath, minReinforcement, maxAgeDays, maxAgeDays) as MemoryItemRow[]
  }

  /** Get all distinct project paths (for pruning iteration). */
  getDistinctProjectPaths(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT project_path FROM memory_items').all() as Array<{
        project_path: string
      }>
    ).map((r) => r.project_path)
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

  /** Remove an entry from the FTS5 content-sync table. */
  private syncFtsDelete(item: MemoryItemRow): void {
    try {
      this.db
        .prepare(
          "INSERT INTO memory_fts(memory_fts, id, content, type, created_by) VALUES('delete', ?, ?, ?, ?)",
        )
        .run(item.id, item.content, item.type, item.created_by || '')
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
      // vec0 virtual tables don't support INSERT OR REPLACE — delete first if exists
      this.db.prepare('DELETE FROM memory_vec WHERE id = ?').run(id)
      this.db.prepare('INSERT INTO memory_vec(id, embedding) VALUES (?, ?)').run(id, blob)
    } catch (err) {
      log.warn(`Failed to insert vector for ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Remove a vector entry (used during update/delete). */
  private deleteVector(id: string): void {
    if (!this.vectorAvailable) return
    try {
      this.db.prepare('DELETE FROM memory_vec WHERE id = ?').run(id)
    } catch {
      // vector unavailable
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
    namespace?: MemoryNamespace,
  ): Array<{ id: string; distance: number }> {
    if (this.vectorAvailable) {
      try {
        const blob = vectorToBlob(embedding)
        if (namespace) {
          const stmt = this.db.prepare(`
            SELECT v.id, vec_distance_cosine(v.embedding, ?) AS distance
            FROM memory_vec v
            JOIN memory_items m ON m.id = v.id
            WHERE m.project_path = ? AND m.namespace = ?
            ORDER BY distance ASC
            LIMIT ?
          `)
          return stmt.all(blob, projectPath, namespace, limit) as Array<{
            id: string
            distance: number
          }>
        }
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

    return this.inMemoryVectorSearch(embedding, projectPath, limit, namespace)
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
    namespace?: MemoryNamespace,
  ): Array<{ id: string; distance: number }> {
    try {
      const sql = namespace
        ? `SELECT m.id, e.embedding
           FROM memory_items m
           JOIN embedding_cache e ON e.content_hash = m.content_hash
           WHERE m.project_path = ? AND m.namespace = ?`
        : `SELECT m.id, e.embedding
           FROM memory_items m
           JOIN embedding_cache e ON e.content_hash = m.content_hash
           WHERE m.project_path = ?`
      const rows = (
        namespace
          ? this.db.prepare(sql).all(projectPath, namespace)
          : this.db.prepare(sql).all(projectPath)
      ) as Array<{ id: string; embedding: Buffer }>

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
    namespace?: MemoryNamespace,
  ): Array<{ id: string; rank: number }> {
    try {
      const terms = query
        .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"`)
        .join(' OR ')
      if (!terms) return []

      if (namespace) {
        const stmt = this.db.prepare(`
          SELECT f.id, bm25(memory_fts) AS rank
          FROM memory_fts f
          JOIN memory_items m ON m.id = f.id
          WHERE memory_fts MATCH ? AND m.project_path = ? AND m.namespace = ?
          ORDER BY rank ASC
          LIMIT ?
        `)
        return stmt.all(terms, projectPath, namespace, limit) as Array<{
          id: string
          rank: number
        }>
      }
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
    // Collect all types: built-in + any custom types in the database
    const dbTypes = (
      this.db.prepare('SELECT DISTINCT type FROM memory_items').all() as Array<{ type: string }>
    ).map((r) => r.type)
    const allTypes = new Set<string>([...MEMORY_TYPES, ...dbTypes])

    for (const type of allTypes) {
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

  /* ---------------------------------------------------------------- */
  /*  Working Memory                                                    */
  /* ---------------------------------------------------------------- */

  getWorkingMemory(chatId: string): string | null {
    const row = this.db.prepare('SELECT content FROM working_memory WHERE chat_id = ?').get(chatId)
    return row ? (row as { content: string }).content : null
  }

  upsertWorkingMemory(chatId: string, content: string, modelId?: string): void {
    this.db
      .prepare(
        `INSERT INTO working_memory (chat_id, content, model_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           content = excluded.content,
           model_id = excluded.model_id,
           updated_at = excluded.updated_at`,
      )
      .run(chatId, content, modelId || null, new Date().toISOString())
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
    namespace: (row.namespace as MemoryItem['namespace']) || 'task',
    createdBy: row.created_by || undefined,
    createdAt: row.created_at,
    reinforcementCount: row.reinforcement_count,
    lastReinforcedAt: row.last_reinforced_at || undefined,
  }
}

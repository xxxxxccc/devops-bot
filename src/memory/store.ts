/**
 * Memory Store — SQLite-backed with JSONL export
 *
 * Primary storage:
 *   data/memory/index.sqlite   — memory items, vectors, FTS, embedding cache
 *
 * Exported views (for AI browsing):
 *   data/memory/*.jsonl         — auto-regenerated from SQLite after writes
 *
 * Conversations (unchanged):
 *   data/memory/conversations/  — monthly JSONL + _state.json metadata
 *
 * The SQLite database is the source of truth for memory items.
 * JSONL files are periodically regenerated so Layer 2 AI can still
 * browse them via `read_file data/memory/decision.jsonl`.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../infra/logger.js'
import { MemoryDatabase, rowToMemoryItem } from './db.js'
import type { MemoryItemRow } from './db.js'
import { computeContentHash } from './dedup.js'
import { deduplicateOrReinforce } from './dedup.js'
import { createEmbeddingProvider, getOrComputeEmbedding } from './embedding.js'
import type { EmbeddingProvider } from './embedding.js'
import { hybridSearch } from './search.js'
import type { SearchOptions } from './search.js'
import type {
  ChatMessage,
  ConversationRecord,
  MemoryCategorySummary,
  MemoryItem,
  MemorySearchResult,
  MemoryType,
} from './types.js'

const log = createLogger('memory')

const __dirname = dirname(fileURLToPath(import.meta.url))
const MEMORY_ROOT = join(__dirname, '..', '..', 'data', 'memory')
const CONVERSATIONS_DIR = join(MEMORY_ROOT, 'conversations')
const STATE_FILE = join(CONVERSATIONS_DIR, '_state.json')
const SQLITE_PATH = join(MEMORY_ROOT, 'index.sqlite')

/** All valid memory types (each maps to a .jsonl export) */
const MEMORY_TYPES: MemoryType[] = [
  'decision',
  'context',
  'preference',
  'issue',
  'task_input',
  'task_result',
]

/** Get current month as YYYY-MM (conversations split monthly) */
function monthKey(): string {
  return new Date().toISOString().slice(0, 7)
}

/** Conversation metadata stored in _state.json */
interface ConversationState {
  chatId: string
  extractedUpTo: number
  projectPath: string
}

export class MemoryStore {
  /** SQLite database (primary storage for memory items) */
  private db: MemoryDatabase | null = null
  /** Embedding provider (null if unavailable — degrades to keyword search) */
  private embeddingProvider: EmbeddingProvider | null = null
  /** Whether embedding provider initialization has been attempted */
  private embeddingInitialized = false

  /** In-memory conversation cache: month (YYYY-MM) -> ConversationRecord */
  private conversations: Map<string, ConversationRecord> = new Map()

  /** Pending messages to append: date -> ChatMessage[] */
  private pendingMessages: Map<string, ChatMessage[]> = new Map()
  /** Whether _state.json needs to be rewritten */
  private stateChanged = false
  private saveTimer: NodeJS.Timeout | null = null

  /** JSONL export debounce timer */
  private exportTimer: NodeJS.Timeout | null = null

  async init(): Promise<void> {
    await Promise.all([
      mkdir(MEMORY_ROOT, { recursive: true }),
      mkdir(CONVERSATIONS_DIR, { recursive: true }),
    ])

    // Open SQLite database (auto-detects Bun vs Node.js)
    this.db = await MemoryDatabase.create(SQLITE_PATH)

    // Migrate existing JSONL data if this is a fresh database
    const totalItems = this.db.getTotalItemCount()
    if (totalItems === 0) {
      log.info('Fresh SQLite database, checking for existing JSONL data...')
      await this.migrateFromJsonl()
    }

    // Initialize embedding provider (async, non-blocking)
    void this.initEmbeddings()

    // Load conversations (unchanged — still JSONL)
    await this.loadConversations()

    const itemsAfterInit = this.db.getTotalItemCount()
    log.info(`Memory store ready (${itemsAfterInit} items, SQLite backend)`)
  }

  /* ---------------------------------------------------------------- */
  /*  Embedding initialization                                         */
  /* ---------------------------------------------------------------- */

  private async initEmbeddings(): Promise<void> {
    if (this.embeddingInitialized) return
    this.embeddingInitialized = true

    try {
      this.embeddingProvider = await createEmbeddingProvider()
      if (this.embeddingProvider && this.db) {
        await this.db.loadVectorExtension(this.embeddingProvider.dimensions)
        // Backfill embeddings for items that don't have vectors yet
        void this.backfillEmbeddings()
      }
    } catch (err) {
      log.warn('Embedding initialization failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Ensure embedding provider is ready. Call before search operations.
   */
  async ensureEmbeddings(): Promise<EmbeddingProvider | null> {
    if (!this.embeddingInitialized) {
      await this.initEmbeddings()
    }
    return this.embeddingProvider
  }

  /* ---------------------------------------------------------------- */
  /*  JSONL migration (one-time, on first init)                        */
  /* ---------------------------------------------------------------- */

  private async migrateFromJsonl(): Promise<void> {
    let migrated = 0
    for (const type of MEMORY_TYPES) {
      const filePath = join(MEMORY_ROOT, `${type}.jsonl`)
      try {
        const content = await readFile(filePath, 'utf-8')
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          try {
            const item = JSON.parse(line) as MemoryItem
            const contentHash = computeContentHash(item.content)
            const row: MemoryItemRow = {
              id: item.id,
              type: item.type,
              content: item.content,
              content_hash: contentHash,
              source: item.source,
              source_id: item.sourceId || null,
              project_path: item.projectPath,
              created_by: item.createdBy || null,
              created_at: item.createdAt,
              reinforcement_count: 1,
              last_reinforced_at: null,
            }
            this.db!.insertItem(row)
            migrated++
          } catch {
            // Skip corrupt line
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`Error reading ${type}.jsonl during migration`, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    if (migrated > 0) {
      log.info(`Migrated ${migrated} items from JSONL to SQLite`)
    } else {
      log.info('No existing JSONL data to migrate')
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Embedding backfill                                               */
  /* ---------------------------------------------------------------- */

  private async backfillEmbeddings(): Promise<void> {
    if (!this.db || !this.embeddingProvider) return

    // Get all items across all projects that need embeddings
    const allItems = this.db.getAllItemsAcrossProjects()
    const needsEmbedding: MemoryItemRow[] = []

    for (const item of allItems) {
      const cached = this.db.getCachedEmbedding(item.content_hash)
      if (!cached) {
        needsEmbedding.push(item)
      } else {
        // Has cached embedding but might not be in vec table — insert it
        this.db.insertVector(item.id, cached)
      }
    }

    if (needsEmbedding.length === 0) return

    log.info(`Backfilling embeddings for ${needsEmbedding.length} items...`)
    const batchSize = 32
    let processed = 0

    for (let i = 0; i < needsEmbedding.length; i += batchSize) {
      const batch = needsEmbedding.slice(i, i + batchSize)
      try {
        const texts = batch.map((item) => item.content)
        const embeddings = await this.embeddingProvider.embedBatch(texts)

        for (let j = 0; j < batch.length; j++) {
          const item = batch[j]
          const embedding = embeddings[j]
          this.db!.setCachedEmbedding(item.content_hash, embedding, this.embeddingProvider!.model)
          this.db!.insertVector(item.id, embedding)
        }
        processed += batch.length
      } catch (err) {
        log.warn(`Embedding backfill batch failed at offset ${i}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    log.info(`Backfill complete: ${processed}/${needsEmbedding.length} items embedded`)
  }

  /* ---------------------------------------------------------------- */
  /*  Conversation loading (from JSONL — unchanged)                    */
  /* ---------------------------------------------------------------- */

  private async loadConversations(): Promise<void> {
    const state = await this.loadState()
    try {
      const files = await readdir(CONVERSATIONS_DIR)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const date = file.replace('.jsonl', '')
        const messages: ChatMessage[] = []
        try {
          const content = await readFile(join(CONVERSATIONS_DIR, file), 'utf-8')
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
              messages.push(JSON.parse(line) as ChatMessage)
            } catch {
              // Skip corrupt line
            }
          }
        } catch {
          continue
        }
        const meta = state[date]
        this.conversations.set(date, {
          id: `conv-${date}`,
          chatId: meta?.chatId || 'unknown',
          date,
          messages,
          projectPath: meta?.projectPath || '',
          createdAt: messages[0]?.timestamp || new Date().toISOString(),
          extractedUpTo: meta?.extractedUpTo || 0,
        })
      }
      log.info(`Loaded ${this.conversations.size} conversation month(s)`)
    } catch {
      // Empty conversations dir
    }
  }

  private async loadState(): Promise<Record<string, ConversationState>> {
    try {
      const content = await readFile(STATE_FILE, 'utf-8')
      return JSON.parse(content) as Record<string, ConversationState>
    } catch {
      return {}
    }
  }

  // ========================
  // Memory Items
  // ========================

  /** Add one or more memory items (with dedup and async embedding) */
  addItems(items: MemoryItem[]): void {
    if (!this.db) return
    for (const item of items) {
      this.addItem({
        type: item.type,
        content: item.content,
        source: item.source,
        sourceId: item.sourceId,
        projectPath: item.projectPath,
        createdBy: item.createdBy,
      })
    }
  }

  /** Create and add a single memory item (with dedup) */
  addItem(partial: Omit<MemoryItem, 'id' | 'createdAt'>): MemoryItem {
    if (!this.db) {
      // Fallback if db not initialized
      return {
        ...partial,
        id: `mem-${randomUUID().slice(0, 8)}`,
        createdAt: new Date().toISOString(),
      }
    }

    const contentHash = computeContentHash(partial.content)
    const row: MemoryItemRow = {
      id: `mem-${randomUUID().slice(0, 8)}`,
      type: partial.type,
      content: partial.content,
      content_hash: contentHash,
      source: partial.source,
      source_id: partial.sourceId || null,
      project_path: partial.projectPath,
      created_by: partial.createdBy || null,
      created_at: new Date().toISOString(),
      reinforcement_count: 1,
      last_reinforced_at: null,
    }

    const result = deduplicateOrReinforce(row, this.db)

    // Async: generate embedding and insert vector (non-blocking)
    if (result.action === 'inserted') {
      void this.embedAndIndex(row.id, contentHash, partial.content)
    }

    // Schedule JSONL export
    this.scheduleExport()

    return result.item
  }

  /** Async: embed content and insert into vector index */
  private async embedAndIndex(id: string, contentHash: string, content: string): Promise<void> {
    if (!this.db || !this.embeddingProvider) return
    try {
      const embedding = await getOrComputeEmbedding(
        contentHash,
        content,
        this.embeddingProvider,
        this.db,
      )
      this.db.insertVector(id, embedding)
    } catch (err) {
      log.warn(`Failed to embed item ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Get all memory items for a project */
  getItems(projectPath: string): MemoryItem[] {
    if (!this.db) return []
    return this.db.getAllItems(projectPath).map(rowToMemoryItem)
  }

  /** Get memory items by type for a project */
  getItemsByType(type: MemoryType, projectPath: string): MemoryItem[] {
    if (!this.db) return []
    return this.db.getItemsByType(type, projectPath).map(rowToMemoryItem)
  }

  /** Hybrid search: vector + keyword + salience ranking */
  async search(
    query: string,
    projectPath: string,
    options?: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    if (!this.db) return []
    const provider = await this.ensureEmbeddings()
    return hybridSearch(query, projectPath, this.db, provider, options)
  }

  // ========================
  // Memory Index (for AI browsing)
  // ========================

  /**
   * Generate a compact summary of all memory categories.
   * The AI uses this to decide which .jsonl files to explore.
   */
  getMemoryIndex(projectPath: string): MemoryCategorySummary[] {
    if (!this.db) return []

    const result: MemoryCategorySummary[] = []
    for (const type of MEMORY_TYPES) {
      const items = this.db.getItemsByType(type, projectPath)
      const recent = items.slice(0, 3).map((row) => ({
        id: row.id,
        preview: row.content.slice(0, 80) + (row.content.length > 80 ? '...' : ''),
        createdAt: row.created_at,
        createdBy: row.created_by || undefined,
      }))
      result.push({ type, count: items.length, recent })
    }
    return result
  }

  /** Get sorted list of available conversation months (most recent first) */
  getConversationDates(): string[] {
    return Array.from(this.conversations.keys()).sort().reverse()
  }

  // ========================
  // Conversations (month-based JSONL — unchanged)
  // ========================

  getConversation(chatId: string, projectPath: string): ConversationRecord {
    const date = monthKey()
    if (this.conversations.has(date)) {
      return this.conversations.get(date)!
    }
    const record: ConversationRecord = {
      id: `conv-${date}`,
      chatId,
      date,
      messages: [],
      projectPath,
      createdAt: new Date().toISOString(),
      extractedUpTo: 0,
    }
    this.conversations.set(date, record)
    this.stateChanged = true
    this.scheduleSave()
    return record
  }

  addMessage(chatId: string, message: ChatMessage, projectPath: string): ConversationRecord {
    const conv = this.getConversation(chatId, projectPath)
    conv.messages.push(message)

    const date = conv.date
    if (!this.pendingMessages.has(date)) {
      this.pendingMessages.set(date, [])
    }
    this.pendingMessages.get(date)!.push(message)
    this.scheduleSave()
    return conv
  }

  getRecentMessages(chatId: string, count = 10): ChatMessage[] {
    const dates = Array.from(this.conversations.keys()).sort().reverse()
    const collected: ChatMessage[] = []

    for (const date of dates) {
      const conv = this.conversations.get(date)!
      if (conv.chatId !== chatId) continue
      collected.unshift(...conv.messages)
      if (collected.length >= count) break
    }

    return collected.slice(-count)
  }

  updateExtractedUpTo(date: string, count: number): void {
    const conv = this.conversations.get(date)
    if (conv) {
      conv.extractedUpTo = count
      this.stateChanged = true
      this.scheduleSave()
    }
  }

  // ========================
  // Persistence (conversations only — memory items are in SQLite)
  // ========================

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveConversations().catch((err) =>
        log.error('Failed to save conversations', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }, 2000)
  }

  /**
   * Flush pending conversation writes to disk.
   * Memory items are already in SQLite (written immediately via addItem).
   */
  async saveConversations(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    const writes: Promise<void>[] = []

    // Append pending messages, grouped by date
    for (const [date, messages] of this.pendingMessages) {
      const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
      writes.push(appendFile(join(CONVERSATIONS_DIR, `${date}.jsonl`), lines, 'utf-8'))
    }

    // Overwrite conversation state if metadata changed
    if (this.stateChanged) {
      const state: Record<string, ConversationState> = {}
      for (const [date, conv] of this.conversations) {
        state[date] = {
          chatId: conv.chatId,
          extractedUpTo: conv.extractedUpTo,
          projectPath: conv.projectPath,
        }
      }
      writes.push(writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8'))
    }

    if (writes.length > 0) {
      await Promise.all(writes)
      const msgCount = Array.from(this.pendingMessages.values()).reduce(
        (sum, msgs) => sum + msgs.length,
        0,
      )
      if (msgCount > 0) {
        log.debug(`Saved ${msgCount} conversation message(s)`)
      }
    }

    this.pendingMessages.clear()
    this.stateChanged = false
  }

  // ========================
  // JSONL export (periodic, for AI browsing)
  // ========================

  private scheduleExport(): void {
    if (this.exportTimer) clearTimeout(this.exportTimer)
    this.exportTimer = setTimeout(() => {
      this.exportJsonl()
    }, 5000) // 5s debounce
  }

  /** Export all memory items to per-type JSONL files */
  exportJsonl(): void {
    if (!this.db) return
    try {
      this.db.exportToJsonl(MEMORY_ROOT)
    } catch (err) {
      log.warn('JSONL export failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ========================
  // Lifecycle
  // ========================

  async close(): Promise<void> {
    const hasPending = this.pendingMessages.size > 0 || this.stateChanged
    if (hasPending) await this.saveConversations()
    if (this.exportTimer) {
      clearTimeout(this.exportTimer)
      this.exportJsonl()
    }
    this.db?.close()
  }
}

// Singleton
let globalStore: MemoryStore | null = null

export async function getMemoryStore(): Promise<MemoryStore> {
  if (!globalStore) {
    globalStore = new MemoryStore()
    await globalStore.init()
  }
  return globalStore
}

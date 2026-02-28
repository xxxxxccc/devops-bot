/**
 * Project-level memory system types
 */

/** Categories of memory */
export type MemoryType =
  | 'decision' // Technical decisions (what was chosen, why)
  | 'context' // Project context (architecture, conventions, directory structure)
  | 'preference' // User preferences (code style, tool preferences)
  | 'issue' // Known issues (bugs, tech debt)
  | 'task_input' // Task requirements (who requested what)
  | 'task_result' // Task results (what files were changed, approach taken)

/** Where this memory came from */
export type MemorySource = 'conversation' | 'task' | 'manual'

/** A single memory item (extracted fact) */
export interface MemoryItem {
  id: string
  type: MemoryType
  /** The extracted fact or record */
  content: string
  /** SHA-256 hash of normalized content (for deduplication) */
  contentHash?: string
  /** Where this memory came from */
  source: MemorySource
  /** Conversation ID or Task ID */
  sourceId: string
  /** Scope to project */
  projectPath: string
  /** Who triggered this memory */
  createdBy?: string
  createdAt: string
  updatedAt?: string
  /** How many times this memory has been reinforced (duplicate content strengthens it) */
  reinforcementCount?: number
  /** When this memory was last reinforced */
  lastReinforcedAt?: string
}

/** A chat message in a conversation record */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  senderName?: string
  timestamp: string
}

/** A recorded conversation (for memory extraction) */
export interface ConversationRecord {
  id: string
  /** Feishu chat ID */
  chatId: string
  /** Month of this conversation segment (YYYY-MM) */
  date: string
  messages: ChatMessage[]
  projectPath: string
  createdAt: string
  /** How many messages have been processed for memory extraction */
  extractedUpTo: number
}

/** Summary of a memory category for AI browsing */
export interface MemoryCategorySummary {
  type: MemoryType
  count: number
  recent: {
    id: string
    preview: string
    createdAt: string
    createdBy?: string
  }[]
}

/** Result of a hybrid search query */
export interface MemorySearchResult {
  /** The matched memory item */
  item: MemoryItem
  /** Relevance score (0-1, higher is better) */
  score: number
  /** How this result was found */
  matchSource: 'vector' | 'keyword' | 'hybrid'
}

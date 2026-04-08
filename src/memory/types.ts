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
  | 'review_feedback' // PR review feedback (specific review comments/findings)
  | 'review_pattern' // Code patterns/anti-patterns discovered during reviews

/** Memory namespace for isolation */
export type MemoryNamespace = 'task' | 'review'

/** Where this memory came from */
export type MemorySource = 'conversation' | 'task' | 'manual' | 'review'

/** A single memory item (extracted fact) */
export interface MemoryItem {
  id: string
  type: MemoryType | (string & {})
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
  /** Namespace for isolation (task vs review). Defaults to 'task'. */
  namespace?: MemoryNamespace
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
  /** IM chat / group ID (each group has its own conversation) */
  chatId: string
  /** Month of this conversation segment (YYYY-MM) */
  date: string
  /** Composite key: chatId:date (used for storage lookup) */
  key: string
  messages: ChatMessage[]
  projectPath: string
  createdAt: string
  /** How many messages have been processed for memory extraction */
  extractedUpTo: number
}

/** Summary of a memory category for AI browsing */
export interface MemoryCategorySummary {
  type: MemoryType | (string & {})
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

/** Audit trail entry for memory changes */
export interface MemoryHistoryEntry {
  id: number
  memoryId: string
  action: 'created' | 'updated' | 'deleted'
  oldContent: string | null
  newContent: string | null
  changedAt: string
  changedBy?: string
}

/** Per-project memory extraction configuration (loaded from .devops-bot.json) */
export interface MemoryExtractionConfig {
  /** Custom memory types beyond the built-in ones */
  customTypes?: Array<{ name: string; description: string }>
  /** Custom extraction prompt for conversation memories (replaces default) */
  conversationPrompt?: string
  /** Custom extraction prompt for task result memories (replaces default) */
  taskResultPrompt?: string
  /** Types to extract (overrides default list). If not set, uses built-in + customTypes */
  extractTypes?: string[]
}

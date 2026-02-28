/**
 * Dispatcher memory injection configuration.
 *
 * Keeps Layer 1 prompt cost bounded and tunable via env vars.
 */

export type MemoryIndexMode = 'always' | 'auto' | 'never'

export interface DispatcherMemoryConfig {
  retrievalTopK: number
  retrievalMinScore: number
  recentChatCount: number
  includeMemoryIndex: MemoryIndexMode
  maxPromptChars: number
  projectContextBudgetChars: number
  memorySectionBudgetChars: number
  indexBudgetChars: number
  recentChatBudgetChars: number
  maxMemorySummaryItems: number
  maxMemorySummaryCharsPerItem: number
  maxDetailedMemoryItems: number
  maxDetailedMemoryCharsPerItem: number
  detailMinScore: number
  metricsEnabled: boolean
}

function parseIntEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, value)
}

function parseFloatEnv(name: string, fallback: number, min = 0, max = 1): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase())
}

function parseIndexMode(raw: string | undefined): MemoryIndexMode {
  if (raw === 'always' || raw === 'auto' || raw === 'never') return raw
  return 'auto'
}

export function getDispatcherMemoryConfig(): DispatcherMemoryConfig {
  return {
    retrievalTopK: parseIntEnv('DISPATCHER_MEMORY_TOP_K', 5, 1),
    retrievalMinScore: parseFloatEnv('DISPATCHER_MEMORY_MIN_SCORE', 0.18, 0, 1),
    recentChatCount: parseIntEnv('DISPATCHER_RECENT_CHAT_COUNT', 4, 0),
    includeMemoryIndex: parseIndexMode(process.env.DISPATCHER_MEMORY_INDEX_MODE),
    maxPromptChars: parseIntEnv('DISPATCHER_MAX_PROMPT_CHARS', 12000, 2000),
    projectContextBudgetChars: parseIntEnv('DISPATCHER_PROJECT_CONTEXT_BUDGET_CHARS', 3500, 0),
    memorySectionBudgetChars: parseIntEnv('DISPATCHER_MEMORY_BUDGET_CHARS', 2800, 0),
    indexBudgetChars: parseIntEnv('DISPATCHER_INDEX_BUDGET_CHARS', 1200, 0),
    recentChatBudgetChars: parseIntEnv('DISPATCHER_RECENT_CHAT_BUDGET_CHARS', 1200, 0),
    maxMemorySummaryItems: parseIntEnv('DISPATCHER_MEMORY_SUMMARY_ITEMS', 5, 0),
    maxMemorySummaryCharsPerItem: parseIntEnv('DISPATCHER_MEMORY_SUMMARY_ITEM_CHARS', 180, 40),
    maxDetailedMemoryItems: parseIntEnv('DISPATCHER_MEMORY_DETAIL_ITEMS', 2, 0),
    maxDetailedMemoryCharsPerItem: parseIntEnv('DISPATCHER_MEMORY_DETAIL_ITEM_CHARS', 280, 60),
    detailMinScore: parseFloatEnv('DISPATCHER_MEMORY_DETAIL_MIN_SCORE', 0.42, 0, 1),
    metricsEnabled: parseBoolEnv('DISPATCHER_MEMORY_METRICS', true),
  }
}

export function hasMemoryIntent(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    /(之前|上次|历史|记录|回顾|记得|有没有做过|做过吗|曾经)/.test(text) ||
    /\b(memory|history|previous|earlier|before|already done|did we)\b/.test(normalized)
  )
}

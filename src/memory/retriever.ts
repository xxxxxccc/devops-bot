/**
 * Memory Retriever — hybrid search integration.
 *
 * Provides two levels of memory access:
 * 1. Memory Index — compact overview for AI to see what's available
 * 2. Hybrid Search — vector + keyword + salience ranking
 *
 * The JSONL file structure allows Layer 2 (Task AI) to
 * directly `cat data/memory/decision.jsonl` via MCP file tools.
 */

import type { SearchOptions } from './search.js'
import type { MemoryStore } from './store.js'
import type { MemoryCategorySummary, MemoryItem, MemorySearchResult } from './types.js'

export class MemoryRetriever {
  constructor(private store: MemoryStore) {}

  /**
   * Retrieve relevant memories for a query using hybrid search.
   * Falls back gracefully: vector+keyword → keyword-only → empty.
   */
  async retrieve(
    query: string,
    projectPath: string,
    options?: SearchOptions,
  ): Promise<MemoryItem[]> {
    const results = await this.store.search(query, projectPath, options)
    return results.map((r) => r.item)
  }

  /**
   * Retrieve with full search results (including scores and match source).
   */
  async retrieveWithScores(
    query: string,
    projectPath: string,
    options?: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    return this.store.search(query, projectPath, options)
  }

  /**
   * Format retrieved memories as context text for AI prompts.
   */
  formatAsContext(items: MemoryItem[], maxCharsPerItem = 240): string {
    if (items.length === 0) return '(no relevant memories found)'

    return items
      .map((item) => {
        const date = new Date(item.createdAt).toLocaleDateString('zh-CN')
        const by = item.createdBy ? ` (by ${item.createdBy})` : ''
        const reinforced =
          item.reinforcementCount && item.reinforcementCount > 1
            ? ` [x${item.reinforcementCount}]`
            : ''
        const content =
          item.content.length > maxCharsPerItem
            ? `${item.content.slice(0, maxCharsPerItem)}...`
            : item.content
        return `- [${item.type}] ${content}${by} (${date})${reinforced}`
      })
      .join('\n')
  }

  /**
   * Stage-1 compact memory rendering with score and source.
   */
  formatSearchResultsAsSummary(
    results: MemorySearchResult[],
    options?: { maxItems?: number; maxCharsPerItem?: number },
  ): string {
    const maxItems = options?.maxItems ?? 5
    const maxCharsPerItem = options?.maxCharsPerItem ?? 160
    if (results.length === 0 || maxItems === 0) return '(no relevant memories found)'

    return results
      .slice(0, maxItems)
      .map((result) => {
        const item = result.item
        const date = new Date(item.createdAt).toLocaleDateString('zh-CN')
        const content =
          item.content.length > maxCharsPerItem
            ? `${item.content.slice(0, maxCharsPerItem)}...`
            : item.content
        return `- [${item.type}] ${content} (score=${result.score.toFixed(3)}, via=${result.matchSource}, ${date})`
      })
      .join('\n')
  }

  /**
   * Format a compact memory storage index for the AI to browse.
   * Shows what categories exist, how many items, and recent previews.
   */
  formatMemoryIndex(categories: MemoryCategorySummary[], conversationDates: string[]): string {
    const lines: string[] = ['data/memory/']
    const nonEmpty = categories.filter((c) => c.count > 0)
    const empty = categories.filter((c) => c.count === 0)

    for (const cat of nonEmpty) {
      lines.push(`├── ${cat.type}.jsonl (${cat.count} items)`)
      for (const item of cat.recent) {
        const date = new Date(item.createdAt).toLocaleDateString('zh-CN')
        const by = item.createdBy ? ` by ${item.createdBy}` : ''
        lines.push(`│   └ ${item.preview}${by} [${date}]`)
      }
      if (cat.count > cat.recent.length) {
        lines.push(`│   ... ${cat.count - cat.recent.length} more`)
      }
    }

    if (empty.length > 0) {
      lines.push(`├── (empty: ${empty.map((c) => `${c.type}.jsonl`).join(', ')})`)
    }

    if (conversationDates.length > 0) {
      lines.push(`└── conversations/ (${conversationDates.length} months)`)
      const shown = conversationDates.slice(0, 5)
      for (const d of shown) {
        lines.push(`    └ ${d}.jsonl`)
      }
      if (conversationDates.length > 5) {
        lines.push(`    ... ${conversationDates.length - 5} more months`)
      }
    } else {
      lines.push('└── conversations/ (empty)')
    }

    return lines.join('\n')
  }
}

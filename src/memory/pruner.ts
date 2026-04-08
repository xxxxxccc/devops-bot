/**
 * Memory Pruner — periodic cleanup of stale, low-value memories.
 *
 * Removes memories that are old, never reinforced, and below the
 * retention threshold. Uses the same salience formula as search
 * to rank candidates by value before pruning.
 */

import type { MemoryDatabase, MemoryItemRow } from './db.js'

const RETENTION_DAYS = parseInt(process.env.MEMORY_RETENTION_DAYS || '90', 10)
const MIN_REINFORCEMENT_KEEP = parseInt(process.env.MEMORY_MIN_REINFORCEMENT_KEEP || '3', 10)
const MAX_ITEMS_PER_PROJECT = parseInt(process.env.MEMORY_MAX_ITEMS_PER_PROJECT || '1000', 10)

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PruneResult {
  pruned: number
  reason: string
}

/* ------------------------------------------------------------------ */
/*  Salience scoring (mirrors search.ts)                               */
/* ------------------------------------------------------------------ */

const RECENCY_HALF_LIFE_DAYS = 30

function computeValueScore(row: MemoryItemRow, nowMs: number): number {
  const reinforcement = Math.log(row.reinforcement_count + 1)
  const lastActive = row.last_reinforced_at || row.created_at
  const daysSince = (nowMs - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)
  const recency = Math.exp((-0.693 * daysSince) / RECENCY_HALF_LIFE_DAYS)
  return reinforcement * recency
}

/* ------------------------------------------------------------------ */
/*  Core                                                               */
/* ------------------------------------------------------------------ */

/**
 * Prune stale memories for a specific project.
 *
 * Two pruning strategies:
 * 1. Age-based: remove old, unreinforced memories past retention period
 * 2. Count-based: if total items exceed max, prune lowest-value to 80% of limit
 */
export function pruneStaleMemories(
  projectPath: string,
  db: MemoryDatabase,
  config?: {
    maxAgeDays?: number
    minReinforcementToKeep?: number
    maxItemsPerProject?: number
  },
): PruneResult {
  const maxAge = config?.maxAgeDays ?? RETENTION_DAYS
  const minReinforcement = config?.minReinforcementToKeep ?? MIN_REINFORCEMENT_KEEP
  const maxItems = config?.maxItemsPerProject ?? MAX_ITEMS_PER_PROJECT

  let pruned = 0
  const reasons: string[] = []

  // Strategy 1: Age-based pruning
  const staleCandidates = db.getStaleCandidates(projectPath, maxAge, minReinforcement)
  if (staleCandidates.length > 0) {
    for (const candidate of staleCandidates) {
      db.deleteItem(candidate.id, 'pruner')
      pruned++
    }
    reasons.push(`${staleCandidates.length} stale (>${maxAge}d, <${minReinforcement}x reinforced)`)
  }

  // Strategy 2: Count-based pruning (if still over limit)
  const totalCount = db.getItemCount(projectPath)
  if (totalCount > maxItems) {
    const targetCount = Math.floor(maxItems * 0.8)
    const toRemove = totalCount - targetCount

    // Get all items, sort by value score ascending (lowest value first)
    const allItems = db.getAllItems(projectPath)
    const nowMs = Date.now()
    const scored = allItems
      .map((item) => ({ item, score: computeValueScore(item, nowMs) }))
      .sort((a, b) => a.score - b.score)

    const countPruned = Math.min(toRemove, scored.length)
    for (let i = 0; i < countPruned; i++) {
      db.deleteItem(scored[i].item.id, 'pruner')
      pruned++
    }
    if (countPruned > 0) {
      reasons.push(`${countPruned} lowest-value (count ${totalCount} > ${maxItems} limit)`)
    }
  }

  return {
    pruned,
    reason: reasons.length > 0 ? reasons.join('; ') : 'nothing to prune',
  }
}

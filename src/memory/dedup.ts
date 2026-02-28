/**
 * Content Deduplication — hash-based dedup with reinforcement counting.
 *
 * When a duplicate memory is about to be stored:
 *   - Instead of creating a new item, reinforce the existing one
 *   - Increment reinforcement_count
 *   - Update last_reinforced_at timestamp
 *
 * Inspired by memU's content hash deduplication + reinforcement pattern.
 */

import { createHash } from 'node:crypto'
import { createLogger } from '../infra/logger.js'
import type { MemoryDatabase, MemoryItemRow } from './db.js'
import { rowToMemoryItem } from './db.js'
import type { MemoryItem } from './types.js'

const log = createLogger('dedup')

/* ------------------------------------------------------------------ */
/*  Content hash                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compute a SHA-256 hash of normalized content.
 *
 * Normalization:
 * - Trim whitespace
 * - Collapse multiple spaces/newlines to single space
 * - Lowercase
 *
 * This ensures minor formatting differences don't create duplicates.
 */
export function computeContentHash(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256').update(normalized, 'utf-8').digest('hex')
}

/* ------------------------------------------------------------------ */
/*  Dedup-or-reinforce                                                 */
/* ------------------------------------------------------------------ */

export interface DedupResult {
  /** Whether this was a new item (inserted) or existing (reinforced) */
  action: 'inserted' | 'reinforced'
  /** The memory item (new or existing) */
  item: MemoryItem
}

/**
 * Check if content already exists in the project.
 * If it does, reinforce the existing item instead of inserting a new one.
 * If it doesn't, insert the new item.
 *
 * @param row  The new item to potentially insert (must have content_hash set)
 * @param db   The memory database instance
 * @returns    Whether the item was inserted or reinforced, and the final item
 */
export function deduplicateOrReinforce(row: MemoryItemRow, db: MemoryDatabase): DedupResult {
  const existing = db.getItemByHash(row.content_hash, row.project_path)

  if (existing) {
    // Reinforce existing item
    db.updateReinforcement(existing.id)
    log.debug(`Reinforced existing memory ${existing.id}`, {
      count: existing.reinforcement_count + 1,
      type: existing.type,
    })
    return {
      action: 'reinforced',
      item: {
        ...rowToMemoryItem(existing),
        reinforcementCount: existing.reinforcement_count + 1,
        lastReinforcedAt: new Date().toISOString(),
      },
    }
  }

  // Insert new item
  db.insertItem(row)
  log.debug(`Inserted new memory ${row.id}`, { type: row.type })
  return {
    action: 'inserted',
    item: rowToMemoryItem(row),
  }
}

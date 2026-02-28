/**
 * Hybrid Search Engine — vector + keyword + salience ranking.
 *
 * Combines:
 * 1. Vector search (cosine similarity via sqlite-vec)
 * 2. Keyword search (BM25 via FTS5)
 * 3. Salience boost (reinforcement count + recency decay from memU)
 *
 * Degrades gracefully:
 * - If sqlite-vec unavailable → keyword-only search
 * - If FTS5 unavailable → vector-only search
 * - If neither → empty results
 */

import { createLogger } from '../infra/logger.js'
import type { MemoryDatabase, MemoryItemRow } from './db.js'
import { rowToMemoryItem } from './db.js'
import type { EmbeddingProvider } from './embedding.js'
import { getOrComputeEmbedding } from './embedding.js'
import { computeContentHash } from './dedup.js'
import type { MemorySearchResult } from './types.js'

const log = createLogger('search')

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

/** Weight for vector search results in hybrid merge (0-1) */
const VECTOR_WEIGHT = 0.7
/** Weight for keyword search results in hybrid merge (0-1) */
const KEYWORD_WEIGHT = 0.3
/** Half-life in days for recency decay (memU-inspired) */
const RECENCY_HALF_LIFE_DAYS = 30
/** Candidate multiplier — fetch more candidates than final limit for better merge */
const CANDIDATE_MULTIPLIER = 3

/* ------------------------------------------------------------------ */
/*  Search options                                                     */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** Maximum results to return. Default: 10 */
  limit?: number
  /** Minimum score threshold (0-1). Default: 0 */
  minScore?: number
  /** Override vector weight. Default: 0.7 */
  vectorWeight?: number
  /** Override keyword weight. Default: 0.3 */
  keywordWeight?: number
}

/* ------------------------------------------------------------------ */
/*  Hybrid search                                                      */
/* ------------------------------------------------------------------ */

/**
 * Perform hybrid search: vector similarity + keyword BM25 + salience ranking.
 *
 * @param query        The search query text
 * @param projectPath  Project scope
 * @param db           Memory database
 * @param provider     Embedding provider (null = keyword-only)
 * @param options      Search configuration
 */
export async function hybridSearch(
  query: string,
  projectPath: string,
  db: MemoryDatabase,
  provider: EmbeddingProvider | null,
  options?: SearchOptions,
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? 10
  const minScore = options?.minScore ?? 0.1
  const vecWeight = options?.vectorWeight ?? VECTOR_WEIGHT
  const kwWeight = options?.keywordWeight ?? KEYWORD_WEIGHT
  const candidateLimit = limit * CANDIDATE_MULTIPLIER

  // Collect scores per item ID
  const scoreMap = new Map<string, { vecScore: number; kwScore: number }>()

  // 1. Vector search (native sqlite-vec or in-memory fallback)
  if (provider) {
    try {
      const queryHash = computeContentHash(query)
      const queryEmbedding = await getOrComputeEmbedding(queryHash, query, provider, db)
      const vecResults = db.vectorSearch(queryEmbedding, projectPath, candidateLimit)

      if (vecResults.length > 0) {
        // Normalize distances to [0, 1] similarity scores
        // cosine distance: 0 = identical, 2 = opposite
        const scores = vecResults.map((r) => ({ id: r.id, score: 1 - r.distance / 2 }))
        const maxScore = Math.max(...scores.map((s) => s.score))
        const minS = Math.min(...scores.map((s) => s.score))
        const range = maxScore - minS || 1

        for (const { id, score } of scores) {
          const normalized = (score - minS) / range
          const existing = scoreMap.get(id) ?? { vecScore: 0, kwScore: 0 }
          existing.vecScore = normalized
          scoreMap.set(id, existing)
        }
      }
    } catch (err) {
      log.warn('Vector search phase failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 2. Keyword search
  const kwResults = db.keywordSearch(query, projectPath, candidateLimit)
  if (kwResults.length > 0) {
    // BM25 rank: lower = more relevant, normalize to [0, 1]
    const ranks = kwResults.map((r) => Math.abs(r.rank))
    const maxRank = Math.max(...ranks)
    const minRank = Math.min(...ranks)
    const range = maxRank - minRank || 1

    for (const { id, rank } of kwResults) {
      const normalized = 1 - (Math.abs(rank) - minRank) / range
      const existing = scoreMap.get(id) ?? { vecScore: 0, kwScore: 0 }
      existing.kwScore = normalized
      scoreMap.set(id, existing)
    }
  }

  if (scoreMap.size === 0) return []

  // 3. Merge scores + salience boost
  const now = Date.now()
  const results: MemorySearchResult[] = []

  for (const [id, { vecScore, kwScore }] of scoreMap) {
    const row = db.getItem(id)
    if (!row) continue

    // Weighted hybrid score
    let hybridScore = vecWeight * vecScore + kwWeight * kwScore

    // Salience boost (memU-inspired)
    hybridScore = applySalienceBoost(hybridScore, row, now)

    if (hybridScore < minScore) continue

    results.push({
      item: rowToMemoryItem(row),
      score: hybridScore,
      matchSource: vecScore > 0 && kwScore > 0 ? 'hybrid' : vecScore > 0 ? 'vector' : 'keyword',
    })
  }

  // Sort by score descending and limit
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

/* ------------------------------------------------------------------ */
/*  Salience ranking (from memU)                                       */
/* ------------------------------------------------------------------ */

/**
 * Apply salience boost based on reinforcement count and recency.
 *
 * Formula:
 *   boosted = score * log(reinforcement + 1) * exp(-0.693 * daysSince / halfLife)
 *
 * - Logarithmic reinforcement prevents runaway scores
 * - Exponential recency decay with configurable half-life
 * - A memory reinforced 10 times yesterday scores higher than one mentioned once a month ago
 */
function applySalienceBoost(score: number, row: MemoryItemRow, nowMs: number): number {
  // Reinforcement factor: log(count + 1) — caps the influence of high counts
  const reinforcement = Math.log(row.reinforcement_count + 1)

  // Recency factor: exponential decay based on last reinforcement (or creation)
  const lastActive = row.last_reinforced_at || row.created_at
  const daysSince = (nowMs - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24)
  const recency = Math.exp((-0.693 * daysSince) / RECENCY_HALF_LIFE_DAYS)

  return score * reinforcement * recency
}

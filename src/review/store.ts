/**
 * Review Store — SQLite-backed storage for tracking reviewed PRs.
 *
 * Prevents duplicate reviews when using polling mode.
 * Shares the memory SQLite database (same pattern as ApprovalStore).
 */

import { createLogger } from '../infra/logger.js'

const log = createLogger('review-store')

export interface ReviewedPR {
  owner: string
  repo: string
  prNumber: number
  lastReviewedCommitSHA: string
  reviewId: number | null
  trigger: string
  reviewedAt: string
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reviewed_prs (
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  pr_number      INTEGER NOT NULL,
  last_reviewed_commit_sha TEXT NOT NULL,
  review_id      INTEGER,
  trigger        TEXT NOT NULL,
  reviewed_at    TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pr_number)
);
`

export class ReviewStore {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  init(): void {
    this.db.exec(SCHEMA_SQL)
    log.info('Review store table initialized')
  }

  /**
   * Check if a PR has been reviewed at this commit.
   * Returns true if the PR was already reviewed with the same head SHA.
   */
  isReviewed(owner: string, repo: string, prNumber: number, headSHA: string): boolean {
    const row = this.db
      .prepare(
        'SELECT last_reviewed_commit_sha FROM reviewed_prs WHERE owner = ? AND repo = ? AND pr_number = ?',
      )
      .get(owner, repo, prNumber) as { last_reviewed_commit_sha: string } | undefined

    return row?.last_reviewed_commit_sha === headSHA
  }

  /** Record that a PR has been reviewed. */
  markReviewed(
    owner: string,
    repo: string,
    prNumber: number,
    headSHA: string,
    reviewId: number | null,
    trigger: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO reviewed_prs (owner, repo, pr_number, last_reviewed_commit_sha, review_id, trigger, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, repo, pr_number) DO UPDATE SET
           last_reviewed_commit_sha = excluded.last_reviewed_commit_sha,
           review_id = excluded.review_id,
           trigger = excluded.trigger,
           reviewed_at = excluded.reviewed_at`,
      )
      .run(owner, repo, prNumber, headSHA, reviewId, trigger, new Date().toISOString())
  }

  /** Get all reviewed PRs for a repo. */
  getReviewedPRs(owner: string, repo: string): ReviewedPR[] {
    const rows = this.db
      .prepare('SELECT * FROM reviewed_prs WHERE owner = ? AND repo = ?')
      .all(owner, repo)
    return rows.map(toReviewedPR)
  }
}

function toReviewedPR(row: any): ReviewedPR {
  return {
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    lastReviewedCommitSHA: row.last_reviewed_commit_sha,
    reviewId: row.review_id,
    trigger: row.trigger,
    reviewedAt: row.reviewed_at,
  }
}

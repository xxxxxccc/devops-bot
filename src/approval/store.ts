/**
 * Approval Store — SQLite-backed storage for pending Tier 2 approvals.
 *
 * Tracks issues created by propose_task that are awaiting a reaction
 * before the bot executes them. Shares the memory SQLite database.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '../infra/logger.js'

const log = createLogger('approval-store')

export interface PendingApproval {
  id: string
  issueNumber: number
  issueUrl: string
  platform: 'github' | 'gitlab'
  host: string
  owner: string
  repo: string
  projectPath: string
  taskTitle: string
  taskDesc: string
  createdBy: string
  imChatId: string
  imMessageId: string | null
  imPlatform: string | null
  riskReason: string | null
  issueLabels: string[] | null
  status: 'pending' | 'approved' | 'expired' | 'rejected'
  createdAt: string
  resolvedAt: string | null
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_approvals (
  id             TEXT PRIMARY KEY,
  issue_number   INTEGER NOT NULL,
  issue_url      TEXT NOT NULL,
  platform       TEXT NOT NULL,
  host           TEXT NOT NULL,
  owner          TEXT NOT NULL,
  repo           TEXT NOT NULL,
  project_path   TEXT NOT NULL,
  task_title     TEXT NOT NULL,
  task_desc      TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  im_chat_id     TEXT NOT NULL,
  im_message_id  TEXT,
  im_platform    TEXT,
  risk_reason    TEXT,
  issue_labels   TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);

CREATE TABLE IF NOT EXISTS processed_issues (
  repo_key          TEXT NOT NULL,
  issue_number      INTEGER NOT NULL,
  task_id           TEXT,
  source            TEXT NOT NULL,
  processed_at      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'processed',
  issue_updated_at  TEXT,
  PRIMARY KEY (repo_key, issue_number)
);
`

const LIFECYCLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lifecycle_watches (
  id              TEXT PRIMARY KEY,
  repo_key        TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_number INTEGER NOT NULL,
  last_state      TEXT NOT NULL,
  im_chat_id      TEXT NOT NULL,
  im_message_id   TEXT,
  title           TEXT,
  created_at      TEXT NOT NULL,
  notified_at     TEXT,
  expired         INTEGER DEFAULT 0,
  UNIQUE(repo_key, resource_type, resource_number)
);
`

const MIGRATION_SQL = `
ALTER TABLE processed_issues ADD COLUMN status TEXT NOT NULL DEFAULT 'processed';
ALTER TABLE processed_issues ADD COLUMN issue_updated_at TEXT;
`

export class ApprovalStore {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  init(): void {
    this.db.exec(SCHEMA_SQL)
    this.db.exec(LIFECYCLE_SCHEMA_SQL)
    this.runMigrations()
    log.info('Approval store table initialized')
  }

  private runMigrations(): void {
    for (const stmt of MIGRATION_SQL.split(';').filter((s) => s.trim())) {
      try {
        this.db.exec(stmt)
      } catch {
        // Column already exists — safe to ignore
      }
    }
  }

  add(data: Omit<PendingApproval, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): string {
    const id = `approval-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO pending_approvals
         (id, issue_number, issue_url, platform, host, owner, repo,
          project_path, task_title, task_desc, created_by,
          im_chat_id, im_message_id, im_platform,
          risk_reason, issue_labels, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        data.issueNumber,
        data.issueUrl,
        data.platform,
        data.host,
        data.owner,
        data.repo,
        data.projectPath,
        data.taskTitle,
        data.taskDesc,
        data.createdBy,
        data.imChatId,
        data.imMessageId ?? null,
        data.imPlatform ?? null,
        data.riskReason ?? null,
        data.issueLabels ? JSON.stringify(data.issueLabels) : null,
        now,
      )
    log.info('Pending approval added', { id, issueUrl: data.issueUrl })
    return id
  }

  getPending(): PendingApproval[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at")
      .all()
    return rows.map(toApproval)
  }

  markApproved(id: string): void {
    this.db
      .prepare("UPDATE pending_approvals SET status = 'approved', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
    log.info('Approval marked as approved', { id })
  }

  markExpired(id: string): void {
    this.db
      .prepare("UPDATE pending_approvals SET status = 'expired', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
    log.info('Approval marked as expired', { id })
  }

  /* ---------------------------------------------------------------- */
  /*  Processed issues tracking                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Returns true if the issue is fully processed and should be skipped.
   * `needs_info` issues with a newer `updated_at` are NOT considered processed.
   */
  isIssueProcessed(repoKey: string, issueNumber: number, issueUpdatedAt?: string): boolean {
    const row = this.db
      .prepare(
        'SELECT status, issue_updated_at FROM processed_issues WHERE repo_key = ? AND issue_number = ?',
      )
      .get(repoKey, issueNumber) as { status: string; issue_updated_at: string | null } | undefined

    if (!row) return false

    if (row.status === 'needs_info' && issueUpdatedAt && row.issue_updated_at) {
      return issueUpdatedAt <= row.issue_updated_at
    }
    return true
  }

  markIssueProcessed(
    repoKey: string,
    issueNumber: number,
    taskId: string | null,
    source: 'bot' | 'external' | 'workspace',
  ): void {
    this.db
      .prepare(
        `INSERT INTO processed_issues (repo_key, issue_number, task_id, source, processed_at, status)
         VALUES (?, ?, ?, ?, ?, 'processed')
         ON CONFLICT(repo_key, issue_number) DO UPDATE SET
           task_id = excluded.task_id,
           source = excluded.source,
           processed_at = excluded.processed_at,
           status = 'processed'`,
      )
      .run(repoKey, issueNumber, taskId, source, new Date().toISOString())
    log.info('Issue marked as processed', { repoKey, issueNumber, source })
  }

  markIssueNeedsInfo(
    repoKey: string,
    issueNumber: number,
    issueUpdatedAt: string,
    source: 'bot' | 'external' | 'workspace',
  ): void {
    this.db
      .prepare(
        `INSERT INTO processed_issues (repo_key, issue_number, task_id, source, processed_at, status, issue_updated_at)
         VALUES (?, ?, NULL, ?, ?, 'needs_info', ?)
         ON CONFLICT(repo_key, issue_number) DO UPDATE SET
           source = excluded.source,
           processed_at = excluded.processed_at,
           status = 'needs_info',
           issue_updated_at = excluded.issue_updated_at`,
      )
      .run(repoKey, issueNumber, source, new Date().toISOString(), issueUpdatedAt)
    log.info('Issue marked as needs_info', { repoKey, issueNumber, issueUpdatedAt })
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle watches                                                */
  /* ---------------------------------------------------------------- */

  addWatch(data: {
    repoKey: string
    resourceType: 'issue' | 'pr'
    resourceNumber: number
    lastState: string
    imChatId: string
    imMessageId?: string | null
    title?: string
  }): void {
    const id = `watch-${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO lifecycle_watches
         (id, repo_key, resource_type, resource_number, last_state,
          im_chat_id, im_message_id, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_key, resource_type, resource_number) DO UPDATE SET
           im_chat_id = excluded.im_chat_id,
           im_message_id = excluded.im_message_id,
           title = COALESCE(excluded.title, lifecycle_watches.title)`,
      )
      .run(
        id,
        data.repoKey,
        data.resourceType,
        data.resourceNumber,
        data.lastState,
        data.imChatId,
        data.imMessageId ?? null,
        data.title ?? null,
        new Date().toISOString(),
      )
  }

  getActiveWatches(): LifecycleWatch[] {
    const rows = this.db
      .prepare('SELECT * FROM lifecycle_watches WHERE expired = 0 ORDER BY created_at')
      .all()
    return rows.map(toWatch)
  }

  updateWatchState(id: string, newState: string): void {
    this.db
      .prepare('UPDATE lifecycle_watches SET last_state = ?, notified_at = ? WHERE id = ?')
      .run(newState, new Date().toISOString(), id)
  }

  expireWatch(id: string): void {
    this.db
      .prepare('UPDATE lifecycle_watches SET expired = 1, notified_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  /** Expire watches older than the given number of days. */
  expireStaleWatches(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
    const result = this.db
      .prepare('UPDATE lifecycle_watches SET expired = 1 WHERE expired = 0 AND created_at < ?')
      .run(cutoff)
    const count = result.changes as number
    if (count > 0) {
      log.info(`Expired ${count} stale lifecycle watches older than ${maxAgeDays} days`)
    }
    return count
  }

  /* ---------------------------------------------------------------- */
  /*  Cleanup                                                          */
  /* ---------------------------------------------------------------- */

  /** Remove approvals older than the given number of days. */
  cleanup(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
    const result = this.db
      .prepare(
        "UPDATE pending_approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND created_at < ?",
      )
      .run(new Date().toISOString(), cutoff)
    const count = result.changes as number
    if (count > 0) {
      log.info(`Expired ${count} stale approvals older than ${maxAgeDays} days`)
    }
    return count
  }
}

export interface LifecycleWatch {
  id: string
  repoKey: string
  resourceType: 'issue' | 'pr'
  resourceNumber: number
  lastState: string
  imChatId: string
  imMessageId: string | null
  title: string | null
  createdAt: string
  notifiedAt: string | null
  expired: boolean
}

function toWatch(row: any): LifecycleWatch {
  return {
    id: row.id,
    repoKey: row.repo_key,
    resourceType: row.resource_type,
    resourceNumber: row.resource_number,
    lastState: row.last_state,
    imChatId: row.im_chat_id,
    imMessageId: row.im_message_id,
    title: row.title,
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
    expired: row.expired === 1,
  }
}

function toApproval(row: any): PendingApproval {
  return {
    id: row.id,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    platform: row.platform,
    host: row.host,
    owner: row.owner,
    repo: row.repo,
    projectPath: row.project_path,
    taskTitle: row.task_title,
    taskDesc: row.task_desc,
    createdBy: row.created_by,
    imChatId: row.im_chat_id,
    imMessageId: row.im_message_id,
    imPlatform: row.im_platform,
    riskReason: row.risk_reason,
    issueLabels: row.issue_labels ? JSON.parse(row.issue_labels) : null,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

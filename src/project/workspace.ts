/**
 * Workspace Registry — SQLite-backed storage for workspace meta-repos.
 *
 * A workspace is a meta-repository containing `workspace.json` that lists
 * multiple sub-projects. The dispatcher AI reads the manifest and CLAUDE.md
 * to understand all available projects and select the correct one per task.
 *
 * Tables:
 *   - workspaces         — registered workspace repos
 *   - chat_workspace_map — which chat groups are bound to which workspaces
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../infra/logger.js'

const log = createLogger('workspace')

export interface WorkspaceRecord {
  id: string
  gitUrl: string
  localPath: string
  defaultBranch: string
  lastSynced: string | null
  createdAt: string
}

export interface WorkspaceProject {
  id: string
  gitUrl: string
  branch: string
  lang?: string
  description?: string
}

export interface WorkspaceManifest {
  defaultBranch?: string
  projects: WorkspaceProject[]
}

const WORKSPACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  git_url         TEXT NOT NULL UNIQUE,
  local_path      TEXT NOT NULL,
  default_branch  TEXT DEFAULT 'main',
  last_synced     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_workspace_map (
  chat_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  last_used     TEXT NOT NULL,
  PRIMARY KEY (chat_id, workspace_id)
);
`

export class WorkspaceRegistry {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  init(): void {
    this.db.exec(WORKSPACE_SCHEMA_SQL)
    log.info('Workspace registry tables initialized')
  }

  register(id: string, gitUrl: string, localPath: string, defaultBranch = 'main'): WorkspaceRecord {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO workspaces (id, git_url, local_path, default_branch, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           git_url = excluded.git_url,
           local_path = excluded.local_path,
           default_branch = excluded.default_branch`,
      )
      .run(id, gitUrl, localPath, defaultBranch, now)

    log.info('Workspace registered', { id, gitUrl })
    return { id, gitUrl, localPath, defaultBranch, lastSynced: null, createdAt: now }
  }

  getById(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
    return row ? toWorkspaceRecord(row) : undefined
  }

  listAll(): WorkspaceRecord[] {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at').all()
    return rows.map(toWorkspaceRecord)
  }

  updateSyncTime(workspaceId: string): void {
    this.db
      .prepare('UPDATE workspaces SET last_synced = ? WHERE id = ?')
      .run(new Date().toISOString(), workspaceId)
  }

  associateChat(chatId: string, workspaceId: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO chat_workspace_map (chat_id, workspace_id, last_used)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id, workspace_id) DO UPDATE SET last_used = excluded.last_used`,
      )
      .run(chatId, workspaceId, now)
    log.info('Chat-workspace association updated', { chatId, workspaceId })
  }

  removeForChat(chatId: string, workspaceId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM chat_workspace_map WHERE chat_id = ? AND workspace_id = ?')
      .run(chatId, workspaceId)
    return result.changes > 0
  }

  getForChat(chatId: string): Array<WorkspaceRecord & { lastUsed: string }> {
    const rows = this.db
      .prepare(
        `SELECT w.*, m.last_used
         FROM workspaces w
         JOIN chat_workspace_map m ON w.id = m.workspace_id
         WHERE m.chat_id = ?
         ORDER BY m.last_used DESC`,
      )
      .all(chatId)

    return rows.map((row: any) => ({
      ...toWorkspaceRecord(row),
      lastUsed: row.last_used,
    }))
  }
}

/**
 * Parse workspace.json from a cloned workspace repo.
 * Returns undefined if the file doesn't exist or is invalid.
 */
export function parseWorkspaceManifest(localPath: string): WorkspaceManifest | undefined {
  try {
    const raw = readFileSync(join(localPath, 'workspace.json'), 'utf-8')
    const data = JSON.parse(raw)

    if (!Array.isArray(data.projects) || data.projects.length === 0) {
      log.warn('workspace.json has no projects array', { localPath })
      return undefined
    }

    const projects: WorkspaceProject[] = []
    for (const p of data.projects) {
      if (!p.id || !p.gitUrl) {
        log.warn('Skipping workspace project with missing id or gitUrl', { project: p })
        continue
      }
      projects.push({
        id: p.id,
        gitUrl: p.gitUrl,
        branch: p.branch || data.defaultBranch || 'main',
        lang: p.lang,
        description: p.description,
      })
    }

    if (projects.length === 0) {
      log.warn('workspace.json has no valid projects after parsing', { localPath })
      return undefined
    }

    log.info(`Parsed workspace manifest: ${projects.length} project(s)`, { localPath })
    return { defaultBranch: data.defaultBranch, projects }
  } catch (err) {
    log.warn('Failed to parse workspace.json', {
      localPath,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * Load the workspace's CLAUDE.md content for injection into AI prompts.
 * Returns empty string if not found.
 */
export function loadWorkspaceContext(localPath: string): string {
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'README.md']) {
    try {
      const content = readFileSync(join(localPath, name), 'utf-8').trim()
      if (content) {
        log.info(`Loaded workspace context from ${name} (${content.length} chars)`)
        return content
      }
    } catch {
      /* try next */
    }
  }
  return ''
}

function toWorkspaceRecord(row: any): WorkspaceRecord {
  return {
    id: row.id,
    gitUrl: row.git_url,
    localPath: row.local_path,
    defaultBranch: row.default_branch,
    lastSynced: row.last_synced,
    createdAt: row.created_at,
  }
}

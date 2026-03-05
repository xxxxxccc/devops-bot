/**
 * Project Registry — SQLite-backed storage for managed projects.
 *
 * Adds two tables to the existing memory SQLite database:
 *   - projects         — registered git repositories
 *   - chat_project_map — which chat groups are bound to which projects
 *
 * Reuses the MemoryDatabase from the memory system.
 */

import { createLogger } from '../infra/logger.js'

const log = createLogger('project-registry')

export interface ProjectRecord {
  id: string
  gitUrl: string
  localPath: string
  defaultBranch: string
  lastSynced: string | null
  createdAt: string
  workspaceId: string | null
}

export interface ChatProjectBinding {
  chatId: string
  projectId: string
  lastUsed: string
}

const REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  git_url        TEXT NOT NULL UNIQUE,
  local_path     TEXT NOT NULL,
  default_branch TEXT DEFAULT 'main',
  last_synced    TEXT,
  created_at     TEXT NOT NULL,
  workspace_id   TEXT
);

CREATE TABLE IF NOT EXISTS chat_project_map (
  chat_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  last_used   TEXT NOT NULL,
  PRIMARY KEY (chat_id, project_id)
);
`

const MIGRATE_WORKSPACE_ID_SQL = `
ALTER TABLE projects ADD COLUMN workspace_id TEXT;
`

export class ProjectRegistry {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  /** Create tables if they don't exist. Call after database is open. */
  init(): void {
    this.db.exec(REGISTRY_SCHEMA_SQL)
    this.migrateWorkspaceId()
    log.info('Project registry tables initialized')
  }

  /** Add workspace_id column to existing projects table if missing. */
  private migrateWorkspaceId(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info('projects')").all() as Array<{
        name: string
      }>
      if (!cols.some((c) => c.name === 'workspace_id')) {
        this.db.exec(MIGRATE_WORKSPACE_ID_SQL)
        log.info('Migrated projects table: added workspace_id column')
      }
    } catch {
      /* column likely already exists */
    }
  }

  register(
    id: string,
    gitUrl: string,
    localPath: string,
    defaultBranch = 'main',
    workspaceId?: string,
  ): ProjectRecord {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO projects (id, git_url, local_path, default_branch, created_at, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           git_url = excluded.git_url,
           local_path = excluded.local_path,
           default_branch = excluded.default_branch,
           workspace_id = excluded.workspace_id`,
      )
      .run(id, gitUrl, localPath, defaultBranch, now, workspaceId ?? null)

    log.info('Project registered', { id, gitUrl, workspaceId })
    return {
      id,
      gitUrl,
      localPath,
      defaultBranch,
      lastSynced: null,
      createdAt: now,
      workspaceId: workspaceId ?? null,
    }
  }

  /** List all projects belonging to a workspace. */
  getByWorkspace(workspaceId: string): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at')
      .all(workspaceId)
    return rows.map(toProjectRecord)
  }

  getById(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    return row ? toProjectRecord(row) : undefined
  }

  getByGitUrl(gitUrl: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE git_url = ?').get(gitUrl)
    return row ? toProjectRecord(row) : undefined
  }

  listAll(): ProjectRecord[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all()
    return rows.map(toProjectRecord)
  }

  updateSyncTime(projectId: string): void {
    this.db
      .prepare('UPDATE projects SET last_synced = ? WHERE id = ?')
      .run(new Date().toISOString(), projectId)
  }

  updateDefaultBranch(projectId: string, branch: string): void {
    this.db.prepare('UPDATE projects SET default_branch = ? WHERE id = ?').run(branch, projectId)
  }

  /** Bind a project to a chat group. Upserts last_used timestamp. */
  associateChat(chatId: string, projectId: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO chat_project_map (chat_id, project_id, last_used)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id, project_id) DO UPDATE SET last_used = excluded.last_used`,
      )
      .run(chatId, projectId, now)
    log.info('Chat-project association updated', { chatId, projectId })
  }

  /** Unbind a project from a chat group. */
  removeForChat(chatId: string, projectId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM chat_project_map WHERE chat_id = ? AND project_id = ?')
      .run(chatId, projectId)
    return result.changes > 0
  }

  /** Get all projects for a chat group, ordered by most recently used. */
  getForChat(chatId: string): Array<ProjectRecord & { lastUsed: string }> {
    const rows = this.db
      .prepare(
        `SELECT p.*, m.last_used
         FROM projects p
         JOIN chat_project_map m ON p.id = m.project_id
         WHERE m.chat_id = ?
         ORDER BY m.last_used DESC`,
      )
      .all(chatId)

    return rows.map((row: any) => ({
      ...toProjectRecord(row),
      lastUsed: row.last_used,
    }))
  }
}

function toProjectRecord(row: any): ProjectRecord {
  return {
    id: row.id,
    gitUrl: row.git_url,
    localPath: row.local_path,
    defaultBranch: row.default_branch,
    lastSynced: row.last_synced,
    createdAt: row.created_at,
    workspaceId: row.workspace_id ?? null,
  }
}

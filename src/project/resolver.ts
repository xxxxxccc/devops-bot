/**
 * Project Resolver — orchestration layer between Registry, RepoManager, and Dispatcher.
 *
 * Does NOT auto-pick a project. Provides project lists for the Dispatcher AI
 * and resolves the selected project to a local path.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../infra/logger.js'
import { type ProjectRecord, ProjectRegistry } from './registry.js'
import { RepoManager, gitUrlToProjectId } from './repo-manager.js'

const log = createLogger('project-resolver')

export interface ProjectInfo {
  id: string
  gitUrl: string
  localPath: string
  defaultBranch: string
  lastUsed: string
}

export class ProjectResolver {
  private registry: ProjectRegistry
  private repoManager: RepoManager
  private fallbackProjectPath: string | undefined

  constructor(db: any, fallbackProjectPath?: string) {
    this.registry = new ProjectRegistry(db)
    this.repoManager = new RepoManager()
    this.fallbackProjectPath = fallbackProjectPath
  }

  init(): void {
    this.registry.init()
  }

  /**
   * Get all projects bound to a chat group.
   * In single-project mode (TARGET_PROJECT_PATH), returns a synthetic entry.
   */
  getProjectsForChat(chatId: string): ProjectInfo[] {
    const projects = this.registry.getForChat(chatId)

    if (projects.length > 0) {
      return projects.map((p) => ({
        id: p.id,
        gitUrl: p.gitUrl,
        localPath: p.localPath,
        defaultBranch: p.defaultBranch,
        lastUsed: p.lastUsed,
      }))
    }

    if (this.fallbackProjectPath) {
      return [
        {
          id: 'local',
          gitUrl: '',
          localPath: this.fallbackProjectPath,
          defaultBranch: 'main',
          lastUsed: new Date().toISOString(),
        },
      ]
    }

    return []
  }

  /**
   * Ensure all registered projects for a chat are cloned locally.
   * Re-clones any whose local directory is missing (e.g. after upgrade).
   */
  async ensureProjectsCloned(chatId: string): Promise<void> {
    const projects = this.registry.getForChat(chatId)
    for (const p of projects) {
      if (!p.gitUrl) continue
      if (!existsSync(join(p.localPath, '.git'))) {
        log.warn('Project directory missing, re-cloning', { id: p.id, gitUrl: p.gitUrl })
        await this.repoManager.ensureRepo(p.gitUrl)
      }
    }
  }

  /**
   * Clone (if needed), register, and bind a project to a chat.
   * Used by the `add_project` intent.
   */
  async ensureAndRegister(gitUrl: string, chatId: string): Promise<ProjectInfo | undefined> {
    const projectId = gitUrlToProjectId(gitUrl)
    if (!projectId) {
      log.error('Cannot parse git URL for registration', { gitUrl })
      return undefined
    }

    const existing = this.registry.getById(projectId)
    if (existing) {
      // Re-clone if local directory was lost (e.g. after upgrade)
      if (!existsSync(join(existing.localPath, '.git'))) {
        log.warn('Registered project missing locally, re-cloning', { projectId })
        await this.repoManager.ensureRepo(existing.gitUrl)
      }
      this.registry.associateChat(chatId, projectId)
      return {
        id: existing.id,
        gitUrl: existing.gitUrl,
        localPath: existing.localPath,
        defaultBranch: existing.defaultBranch,
        lastUsed: new Date().toISOString(),
      }
    }

    const localPath = await this.repoManager.ensureRepo(gitUrl)
    if (!localPath) return undefined

    const defaultBranch = await this.repoManager.detectDefaultBranch(localPath)
    const record = this.registry.register(projectId, gitUrl, localPath, defaultBranch)
    this.registry.associateChat(chatId, projectId)

    return {
      id: record.id,
      gitUrl: record.gitUrl,
      localPath: record.localPath,
      defaultBranch: record.defaultBranch,
      lastUsed: new Date().toISOString(),
    }
  }

  /**
   * Remove a project binding from a chat.
   */
  removeFromChat(chatId: string, projectId: string): boolean {
    return this.registry.removeForChat(chatId, projectId)
  }

  /**
   * Sync a project repo and return its local path.
   * Updates the last_used timestamp for the chat-project binding.
   */
  async syncAndResolve(projectId: string, chatId?: string): Promise<string | undefined> {
    if (projectId === 'local' && this.fallbackProjectPath) {
      return this.fallbackProjectPath
    }

    const project = this.registry.getById(projectId)
    if (!project) {
      log.error('Project not found in registry', { projectId })
      return undefined
    }

    // Re-clone if local directory was lost (e.g. after upgrade)
    if (!existsSync(join(project.localPath, '.git'))) {
      log.warn('Project directory missing, re-cloning before sync', { projectId })
      const cloned = await this.repoManager.ensureRepo(project.gitUrl)
      if (!cloned) {
        log.error('Re-clone failed', { projectId, gitUrl: project.gitUrl })
        return undefined
      }
    }

    await this.repoManager.syncRepo(project.localPath, project.defaultBranch, project.gitUrl)
    this.registry.updateSyncTime(projectId)

    if (chatId) {
      this.registry.associateChat(chatId, projectId)
    }

    return project.localPath
  }

  /**
   * Get fallback project path (single-project mode).
   */
  getFallbackProject(): string | undefined {
    return this.fallbackProjectPath
  }

  /**
   * Get a project record by ID.
   */
  getProject(projectId: string): ProjectRecord | undefined {
    return this.registry.getById(projectId)
  }

  /** Get the underlying project registry (for approval poller repo scanning). */
  getRegistry(): ProjectRegistry {
    return this.registry
  }
}

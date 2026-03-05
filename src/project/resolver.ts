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
import {
  WorkspaceRegistry,
  parseWorkspaceManifest,
  loadWorkspaceContext,
  type WorkspaceManifest,
  type WorkspaceRecord,
} from './workspace.js'

const log = createLogger('project-resolver')

export interface ProjectInfo {
  id: string
  gitUrl: string
  localPath: string
  defaultBranch: string
  lastUsed: string
}

export interface WorkspaceInfo {
  record: WorkspaceRecord
  manifest: WorkspaceManifest
  context: string
}

export class ProjectResolver {
  private registry: ProjectRegistry
  private workspaceRegistry: WorkspaceRegistry
  private repoManager: RepoManager
  private fallbackProjectPath: string | undefined

  constructor(db: any, fallbackProjectPath?: string) {
    this.registry = new ProjectRegistry(db)
    this.workspaceRegistry = new WorkspaceRegistry(db)
    this.repoManager = new RepoManager()
    this.fallbackProjectPath = fallbackProjectPath
  }

  init(): void {
    this.registry.init()
    this.workspaceRegistry.init()
  }

  /**
   * Get all projects bound to a chat group, including workspace sub-projects.
   * In single-project mode (TARGET_PROJECT_PATH), returns a synthetic entry.
   */
  getProjectsForChat(chatId: string): ProjectInfo[] {
    const directProjects = this.registry.getForChat(chatId)
    const results: ProjectInfo[] = directProjects.map((p) => ({
      id: p.id,
      gitUrl: p.gitUrl,
      localPath: p.localPath,
      defaultBranch: p.defaultBranch,
      lastUsed: p.lastUsed,
    }))

    const seenIds = new Set(results.map((p) => p.id))

    // Include workspace sub-projects that have been cloned (registered)
    const workspaces = this.workspaceRegistry.getForChat(chatId)
    for (const ws of workspaces) {
      const wsProjects = this.registry.getByWorkspace(ws.id)
      for (const p of wsProjects) {
        if (seenIds.has(p.id)) continue
        seenIds.add(p.id)
        results.push({
          id: p.id,
          gitUrl: p.gitUrl,
          localPath: p.localPath,
          defaultBranch: p.defaultBranch,
          lastUsed: ws.lastUsed,
        })
      }
    }

    if (results.length > 0) return results

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
   * Re-clones any whose local directory is missing (e.g. after upgrade)
   * and re-detects the default branch.
   */
  async ensureProjectsCloned(chatId: string): Promise<void> {
    const projects = this.registry.getForChat(chatId)
    for (const p of projects) {
      if (!p.gitUrl) continue
      if (!existsSync(join(p.localPath, '.git'))) {
        log.warn('Project directory missing, re-cloning', { id: p.id, gitUrl: p.gitUrl })
        const cloned = await this.repoManager.ensureRepo(p.gitUrl)
        if (cloned) {
          await this.refreshDefaultBranch(p.id, cloned)
        }
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
        const cloned = await this.repoManager.ensureRepo(existing.gitUrl)
        if (cloned) {
          await this.refreshDefaultBranch(projectId, cloned)
        }
      }
      this.registry.associateChat(chatId, projectId)
      const refreshed = this.registry.getById(projectId)!
      return {
        id: refreshed.id,
        gitUrl: refreshed.gitUrl,
        localPath: refreshed.localPath,
        defaultBranch: refreshed.defaultBranch,
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

    let project = this.registry.getById(projectId)
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
      await this.refreshDefaultBranch(projectId, cloned)
      project = this.registry.getById(projectId)!
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

  /** Re-detect and update the default branch after a fresh clone. */
  private async refreshDefaultBranch(projectId: string, localPath: string): Promise<void> {
    const branch = await this.repoManager.detectDefaultBranch(localPath)
    this.registry.updateDefaultBranch(projectId, branch)
    log.info('Default branch updated after re-clone', { projectId, branch })
  }

  /** Get the underlying project registry (for approval poller repo scanning). */
  getRegistry(): ProjectRegistry {
    return this.registry
  }

  /* ---------------------------------------------------------------- */
  /*  Workspace mode                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Clone (if needed), register, and bind a workspace to a chat.
   * Used by the `add_workspace` intent.
   */
  async ensureAndRegisterWorkspace(
    gitUrl: string,
    chatId: string,
  ): Promise<WorkspaceInfo | undefined> {
    const workspaceId = gitUrlToProjectId(gitUrl)
    if (!workspaceId) {
      log.error('Cannot parse workspace git URL', { gitUrl })
      return undefined
    }

    const existing = this.workspaceRegistry.getById(workspaceId)
    let localPath: string

    if (existing) {
      if (!existsSync(join(existing.localPath, '.git'))) {
        log.warn('Workspace directory missing, re-cloning', { workspaceId })
        const cloned = await this.repoManager.ensureRepo(existing.gitUrl)
        if (!cloned) return undefined
        localPath = cloned
      } else {
        localPath = existing.localPath
        await this.repoManager.syncRepo(localPath, existing.defaultBranch, existing.gitUrl)
      }
    } else {
      const cloned = await this.repoManager.ensureRepo(gitUrl)
      if (!cloned) return undefined
      localPath = cloned
    }

    const manifest = parseWorkspaceManifest(localPath)
    if (!manifest) {
      log.error('Not a valid workspace (no workspace.json)', { gitUrl, localPath })
      return undefined
    }

    const defaultBranch = manifest.defaultBranch || 'main'
    const record = this.workspaceRegistry.register(workspaceId, gitUrl, localPath, defaultBranch)
    this.workspaceRegistry.associateChat(chatId, workspaceId)
    this.workspaceRegistry.updateSyncTime(workspaceId)

    const context = loadWorkspaceContext(localPath)
    return { record, manifest, context }
  }

  /**
   * Resolve a sub-project from a workspace by its git URL.
   * Clones on demand if not yet registered.
   */
  async resolveFromWorkspace(
    targetGitUrl: string,
    chatId: string,
    branchOverride?: string,
  ): Promise<string | undefined> {
    const projectId = gitUrlToProjectId(targetGitUrl)
    if (!projectId) {
      log.error('Cannot parse target git URL for workspace resolve', { targetGitUrl })
      return undefined
    }

    let project = this.registry.getById(projectId)

    if (project) {
      if (!existsSync(join(project.localPath, '.git'))) {
        log.warn('Workspace sub-project directory missing, re-cloning', { projectId })
        const cloned = await this.repoManager.ensureRepo(project.gitUrl)
        if (!cloned) return undefined
      }
    } else {
      const localPath = await this.repoManager.ensureRepo(targetGitUrl)
      if (!localPath) return undefined

      const detectedBranch = await this.repoManager.detectDefaultBranch(localPath)
      const branch = branchOverride || detectedBranch

      const workspaceId = this.findWorkspaceForGitUrl(targetGitUrl, chatId)
      this.registry.register(projectId, targetGitUrl, localPath, branch, workspaceId ?? undefined)
      if (chatId) this.registry.associateChat(chatId, projectId)

      project = this.registry.getById(projectId)
    }

    if (!project) return undefined

    if (branchOverride && branchOverride !== project.defaultBranch) {
      this.registry.updateDefaultBranch(projectId, branchOverride)
      project = this.registry.getById(projectId)!
    }

    await this.repoManager.syncRepo(project.localPath, project.defaultBranch, project.gitUrl)
    this.registry.updateSyncTime(projectId)
    if (chatId) this.registry.associateChat(chatId, projectId)

    return project.localPath
  }

  /** Get workspaces bound to a chat, with parsed manifests and context. */
  getWorkspacesForChat(chatId: string): WorkspaceInfo[] {
    const workspaces = this.workspaceRegistry.getForChat(chatId)
    const results: WorkspaceInfo[] = []

    for (const ws of workspaces) {
      const manifest = parseWorkspaceManifest(ws.localPath)
      if (!manifest) continue
      const context = loadWorkspaceContext(ws.localPath)
      results.push({ record: ws, manifest, context })
    }

    return results
  }

  /** Sync workspace repo to latest and re-parse manifest. */
  async syncWorkspace(workspaceId: string): Promise<WorkspaceInfo | undefined> {
    const ws = this.workspaceRegistry.getById(workspaceId)
    if (!ws) return undefined

    await this.repoManager.syncRepo(ws.localPath, ws.defaultBranch, ws.gitUrl)
    this.workspaceRegistry.updateSyncTime(workspaceId)

    const manifest = parseWorkspaceManifest(ws.localPath)
    if (!manifest) return undefined

    const context = loadWorkspaceContext(ws.localPath)
    return { record: ws, manifest, context }
  }

  /** Remove a workspace binding from a chat. */
  removeWorkspaceFromChat(chatId: string, workspaceId: string): boolean {
    return this.workspaceRegistry.removeForChat(chatId, workspaceId)
  }

  /** Get workspace info by ID (for poller use — no chat context needed). */
  getWorkspaceInfo(workspaceId: string): WorkspaceInfo | undefined {
    const ws = this.workspaceRegistry.getById(workspaceId)
    if (!ws) return undefined
    const manifest = parseWorkspaceManifest(ws.localPath)
    if (!manifest) return undefined
    const context = loadWorkspaceContext(ws.localPath)
    return { record: ws, manifest, context }
  }

  /** List all registered workspaces with parsed manifests and context. */
  getAllWorkspaceInfos(): WorkspaceInfo[] {
    const workspaces = this.workspaceRegistry.listAll()
    const results: WorkspaceInfo[] = []
    for (const ws of workspaces) {
      const manifest = parseWorkspaceManifest(ws.localPath)
      if (!manifest) continue
      const context = loadWorkspaceContext(ws.localPath)
      results.push({ record: ws, manifest, context })
    }
    return results
  }

  /** Find which workspace (if any) owns a given git URL for the current chat. */
  private findWorkspaceForGitUrl(gitUrl: string, chatId: string): string | null {
    const workspaces = this.workspaceRegistry.getForChat(chatId)
    for (const ws of workspaces) {
      const manifest = parseWorkspaceManifest(ws.localPath)
      if (!manifest) continue
      if (manifest.projects.some((p) => p.gitUrl === gitUrl)) {
        return ws.id
      }
    }
    return null
  }
}

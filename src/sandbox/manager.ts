/**
 * Sandbox Manager — Git Worktree-based isolation for task execution.
 *
 * Each task gets its own worktree (separate directory + branch) so that:
 * - Tasks never interfere with the local working tree
 * - Multiple tasks can run concurrently (future)
 * - Changes are committed on isolated branches and submitted as PRs
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { createLogger } from '../infra/logger.js'

const log = createLogger('sandbox')

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Sandbox {
  taskId: string
  branchName: string
  worktreePath: string
  baseBranch: string
  projectPath: string
  /** Submodule paths detected in the project (empty if none) */
  submodules: string[]
}

export interface SandboxConfig {
  /** Base directory for worktrees (default: /tmp/devops-bot-sandbox) */
  baseDir: string
  /** Whether to auto-create PR after task completion (default: true) */
  autoCreatePR: boolean
  /** Whether to create PR as draft (default: true) */
  draftPR: boolean
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export function loadSandboxConfig(): SandboxConfig {
  return {
    baseDir: process.env.SANDBOX_BASE_DIR || '/tmp/devops-bot-sandbox',
    autoCreatePR: process.env.AUTO_CREATE_PR !== 'false',
    draftPR: process.env.PR_DRAFT !== 'false',
  }
}

/* ------------------------------------------------------------------ */
/*  Sandbox Manager                                                    */
/* ------------------------------------------------------------------ */

export class SandboxManager {
  private readonly config: SandboxConfig
  private activeSandboxes: Map<string, Sandbox> = new Map()

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...loadSandboxConfig(), ...config }
    mkdirSync(this.config.baseDir, { recursive: true })
  }

  get sandboxConfig(): SandboxConfig {
    return this.config
  }

  /**
   * Create an isolated worktree sandbox for a task.
   *
   * 1. Records current branch as baseBranch
   * 2. Creates a new branch `devops-bot/task-{id}-{slug}`
   * 3. Creates a worktree at `{baseDir}/{taskId}`
   */
  async createSandbox(taskId: string, taskTitle: string, projectPath: string): Promise<Sandbox> {
    const git = simpleGit(projectPath)

    // Record the current branch as the base for the PR
    const status = await git.status()
    const baseBranch = status.current || 'main'

    const slug = toSlug(taskTitle)
    const shortId = taskId.replace(/^task-/, '').slice(0, 8)
    const branchName = `devops-bot/task-${shortId}-${slug}`
    const worktreePath = join(this.config.baseDir, taskId)

    // Clean up stale worktree if directory exists
    if (existsSync(worktreePath)) {
      log.warn('Stale worktree found, cleaning up', { taskId, worktreePath })
      await this.forceRemoveWorktree(git, worktreePath)
    }

    log.info('Creating sandbox', { taskId, branchName, worktreePath, baseBranch })

    // Create worktree with a new branch based on current HEAD
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])

    // Initialize submodules in the worktree if any exist
    const submodules = await this.initSubmodules(projectPath, worktreePath)

    const sandbox: Sandbox = {
      taskId,
      branchName,
      worktreePath,
      baseBranch,
      projectPath,
      submodules,
    }
    this.activeSandboxes.set(taskId, sandbox)

    log.info('Sandbox created', { taskId, branchName, worktreePath })
    return sandbox
  }

  /**
   * Finalize a sandbox: push the branch and optionally create a PR.
   * Returns the PR/MR URL if created.
   */
  async finalizeSandbox(
    sandbox: Sandbox,
    taskTitle: string,
    taskDescription?: string,
  ): Promise<{ prUrl?: string }> {
    const git = simpleGit(sandbox.worktreePath)

    // Check if there are any commits on this branch beyond the base
    const hasChanges = await this.branchHasNewCommits(sandbox)
    if (!hasChanges) {
      log.info('No commits in sandbox, skipping finalize', { taskId: sandbox.taskId })
      return {}
    }

    // Push the branch
    log.info('Pushing sandbox branch', { branch: sandbox.branchName })
    await git.push(['--set-upstream', 'origin', sandbox.branchName])

    // Create PR if configured
    if (!this.config.autoCreatePR) {
      log.info('Auto PR creation disabled, skipping', { taskId: sandbox.taskId })
      return {}
    }

    const { createPullRequest } = await import('./pr-creator.js')
    const prUrl = await createPullRequest({
      projectPath: sandbox.projectPath,
      branchName: sandbox.branchName,
      baseBranch: sandbox.baseBranch,
      title: taskTitle,
      description: taskDescription,
      draft: this.config.draftPR,
    })

    return { prUrl: prUrl ?? undefined }
  }

  /**
   * Clean up sandbox resources (worktree + branch).
   * Safe to call even if creation partially failed.
   */
  async cleanupSandbox(sandbox: Sandbox): Promise<void> {
    const git = simpleGit(sandbox.projectPath)

    log.info('Cleaning up sandbox', { taskId: sandbox.taskId })

    await this.forceRemoveWorktree(git, sandbox.worktreePath)
    this.activeSandboxes.delete(sandbox.taskId)

    log.info('Sandbox cleaned up', { taskId: sandbox.taskId })
  }

  /** Get active sandbox for a task */
  getSandbox(taskId: string): Sandbox | undefined {
    return this.activeSandboxes.get(taskId)
  }

  /* ---------------------------------------------------------------- */
  /*  Internal helpers                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Detect and initialize submodules in the worktree.
   *
   * `git worktree add` does NOT checkout submodules — their directories
   * will be empty. We run `git submodule update --init --recursive` in the
   * worktree to populate them.
   *
   * Returns the list of submodule paths (empty if none).
   */
  private async initSubmodules(projectPath: string, worktreePath: string): Promise<string[]> {
    const mainGit = simpleGit(projectPath)

    // Detect submodules from the main repo
    let submodulePaths: string[] = []
    try {
      const raw = await mainGit.raw(['config', '--file', '.gitmodules', '--list'])
      if (!raw || !raw.trim()) return []

      submodulePaths = raw
        .split('\n')
        .filter((line) => line.startsWith('submodule.') && line.includes('.path='))
        .map((line) => line.split('=').slice(1).join('=').trim())
        .filter(Boolean)

      if (submodulePaths.length === 0) return []
    } catch {
      // No .gitmodules or parsing failed — no submodules
      return []
    }

    log.info('Initializing submodules in worktree', {
      worktreePath,
      submodules: submodulePaths,
    })

    const worktreeGit = simpleGit(worktreePath)
    try {
      await worktreeGit.raw(['submodule', 'update', '--init', '--recursive'])
      log.info('Submodules initialized', { count: submodulePaths.length })
    } catch (error) {
      log.warn('Submodule init failed, continuing without submodules', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return submodulePaths
  }

  private async branchHasNewCommits(sandbox: Sandbox): Promise<boolean> {
    try {
      const git = simpleGit(sandbox.worktreePath)
      const log = await git.log([`${sandbox.baseBranch}..HEAD`, '--oneline'])
      return log.total > 0
    } catch {
      return false
    }
  }

  private async forceRemoveWorktree(
    git: ReturnType<typeof simpleGit>,
    worktreePath: string,
  ): Promise<void> {
    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath])
    } catch {
      // If git worktree remove fails, clean up manually
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true })
      }
      // Prune stale worktree references
      try {
        await git.raw(['worktree', 'prune'])
      } catch {
        // best effort
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Convert a task title to a short kebab-case slug (max 30 chars) */
function toSlug(title: string): string {
  return (
    title
      .toLowerCase()
      // Replace CJK and non-alphanumeric with hyphens
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '') || 'task'
  )
}

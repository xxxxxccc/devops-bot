/**
 * Sandbox Manager — Git Worktree-based isolation for task execution.
 *
 * Each task gets its own worktree (separate directory + branch) so that:
 * - Tasks never interfere with the local working tree
 * - Multiple tasks can run concurrently (future)
 * - Changes are committed on isolated branches and submitted as PRs
 *
 * After creating a worktree, dependencies are installed automatically by
 * detecting the project's package manager. A custom setup command can be
 * provided via SANDBOX_SETUP_COMMAND for non-standard projects.
 */

import { exec } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { createLogger } from '../infra/logger.js'
import { detectRepo } from './pr-creator.js'

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
  /** True when sandbox was created on an existing PR branch (skip PR creation on finalize). */
  isExistingBranch?: boolean
}

export interface SandboxConfig {
  /** Base directory for worktrees (default: /tmp/devops-bot-sandbox) */
  baseDir: string
  /** Whether to auto-create PR after task completion (default: true) */
  autoCreatePR: boolean
  /** Whether to create PR as draft (default: true) */
  draftPR: boolean
  /** Custom command to run after worktree creation (overrides auto-detect) */
  setupCommand?: string
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export function loadSandboxConfig(): SandboxConfig {
  return {
    baseDir: process.env.SANDBOX_BASE_DIR || '/tmp/devops-bot-sandbox',
    autoCreatePR: process.env.AUTO_CREATE_PR !== 'false',
    draftPR: process.env.PR_DRAFT !== 'false',
    setupCommand: process.env.SANDBOX_SETUP_COMMAND || undefined,
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
   * 4. Installs dependencies (auto-detected or via SANDBOX_SETUP_COMMAND)
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

    // Install dependencies so tools (biome, tsc, etc.) are available
    await this.installDependencies(projectPath, worktreePath)

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
   * Create a sandbox that checks out an existing remote branch (e.g. a PR branch).
   *
   * Unlike `createSandbox` (which creates a new branch), this fetches the remote
   * branch and creates a worktree tracking it. `finalizeSandbox` will only push
   * (no PR creation) when `isExistingBranch` is set.
   */
  async createSandboxOnBranch(
    taskId: string,
    existingBranch: string,
    projectPath: string,
  ): Promise<Sandbox> {
    const git = simpleGit(projectPath)
    const worktreePath = join(this.config.baseDir, taskId)

    if (existsSync(worktreePath)) {
      log.warn('Stale worktree found, cleaning up', { taskId, worktreePath })
      await this.forceRemoveWorktree(git, worktreePath)
    }

    // Remove any other worktree that has this branch checked out
    await this.removeWorktreeForBranch(git, existingBranch)

    log.info('Creating sandbox on existing branch', { taskId, existingBranch, worktreePath })

    // Explicit refspec so that origin/<branch> tracking ref is created
    const refspec = `+refs/heads/${existingBranch}:refs/remotes/origin/${existingBranch}`
    const authArgs = await getGitHubAuthArgs(projectPath)
    if (authArgs.length > 0) {
      await git.raw([...authArgs, 'fetch', 'origin', refspec])
    } else {
      await git.fetch(['origin', refspec])
    }

    // -B resets local branch to match remote; creates worktree in one step
    await git.raw([
      'worktree',
      'add',
      '-B',
      existingBranch,
      worktreePath,
      `origin/${existingBranch}`,
    ])

    await this.installDependencies(projectPath, worktreePath)
    const submodules = await this.initSubmodules(projectPath, worktreePath)

    const sandbox: Sandbox = {
      taskId,
      branchName: existingBranch,
      worktreePath,
      baseBranch: existingBranch,
      projectPath,
      submodules,
      isExistingBranch: true,
    }
    this.activeSandboxes.set(taskId, sandbox)

    log.info('Sandbox created on existing branch', { taskId, existingBranch, worktreePath })
    return sandbox
  }

  /**
   * Finalize a sandbox: push the branch and optionally create a PR/MR.
   *
   * For GitLab, push and MR creation happen in one step via push options
   * (zero extra config — uses the same git credentials as push).
   * For GitHub, push first then create PR via API or CLI.
   */
  async finalizeSandbox(
    sandbox: Sandbox,
    taskTitle: string,
    taskDescription?: string,
    createdBy?: string,
    issueNumber?: number,
  ): Promise<{ prUrl?: string }> {
    const hasChanges = await this.branchHasNewCommits(sandbox)
    if (!hasChanges) {
      log.info('No commits in sandbox, skipping finalize', { taskId: sandbox.taskId })
      return {}
    }

    // Existing branch (auto-fix): push only, PR already exists
    if (sandbox.isExistingBranch) {
      log.info('Existing branch sandbox — pushing without PR creation', {
        taskId: sandbox.taskId,
        branch: sandbox.branchName,
      })
      await authenticatedPush(sandbox.worktreePath, sandbox.branchName, sandbox.projectPath)
      return {}
    }

    const prOpts = {
      worktreePath: sandbox.worktreePath,
      projectPath: sandbox.projectPath,
      branchName: sandbox.branchName,
      baseBranch: sandbox.baseBranch,
      title: taskTitle,
      description: taskDescription,
      createdBy,
      issueNumber,
      draft: this.config.draftPR,
    }

    if (!this.config.autoCreatePR) {
      log.info('Auto PR creation disabled, pushing branch only')
      const { pushOnly } = await import('./pr-creator.js')
      await pushOnly(prOpts)
      return {}
    }

    const { pushAndCreatePR } = await import('./pr-creator.js')
    const prUrl = await pushAndCreatePR(prOpts)
    return { prUrl }
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
   * Install dependencies in the worktree so CLI tools are available.
   *
   * Strategy:
   *   1. If SANDBOX_SETUP_COMMAND is set, run it (for iOS/Android/custom projects)
   *   2. Otherwise, auto-detect the package manager from lockfiles and run install
   *
   * Auto-detected ecosystems:
   *   - pnpm  (pnpm-lock.yaml)   → pnpm install --frozen-lockfile
   *   - npm   (package-lock.json) → npm ci
   *   - yarn  (yarn.lock)         → yarn install --frozen-lockfile
   *   - bun   (bun.lockb)         → bun install --frozen-lockfile
   *   - pip   (requirements.txt)  → pip install -r requirements.txt
   *   - composer (composer.lock)   → composer install --no-interaction
   *   - bundler (Gemfile.lock)     → bundle install
   *   - cocoapods (Podfile.lock)   → pod install
   */
  private async installDependencies(projectPath: string, worktreePath: string): Promise<void> {
    if (this.config.setupCommand) {
      log.info('Running custom sandbox setup command', { command: this.config.setupCommand })
      await this.runSetupCommand(this.config.setupCommand, worktreePath)
      return
    }

    const commands = detectInstallCommands(projectPath)
    if (commands.length === 0) {
      log.info('No package manager detected, skipping dependency install')
      return
    }

    for (const { name, command } of commands) {
      log.info(`Installing ${name} dependencies in sandbox`, { command })
      await this.runSetupCommand(command, worktreePath)
    }
  }

  private runSetupCommand(command: string, cwd: string): Promise<void> {
    return new Promise((resolve) => {
      const child = exec(command, {
        cwd,
        timeout: 300_000, // 5 min
        env: { ...process.env, CI: '1' },
        maxBuffer: 10 * 1024 * 1024,
      })

      child.on('close', (code) => {
        if (code !== 0) {
          log.warn('Sandbox setup command exited with non-zero code', { command, code })
        }
        resolve()
      })

      child.on('error', (error) => {
        log.warn('Sandbox setup command failed, tools may be unavailable', {
          command,
          error: error.message,
        })
        resolve()
      })
    })
  }

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

  /**
   * Find and remove any existing worktree that has `branch` checked out.
   * Prevents "branch is already used by worktree" errors.
   */
  private async removeWorktreeForBranch(
    git: ReturnType<typeof simpleGit>,
    branch: string,
  ): Promise<void> {
    try {
      await git.raw(['worktree', 'prune'])
      const list = await git.raw(['worktree', 'list', '--porcelain'])
      let currentPath: string | undefined
      for (const line of list.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice('worktree '.length).trim()
        }
        if (line.startsWith('branch refs/heads/') && currentPath) {
          const branchName = line.slice('branch refs/heads/'.length).trim()
          if (branchName === branch) {
            log.warn('Removing stale worktree that has branch checked out', {
              branch,
              worktreePath: currentPath,
            })
            await this.forceRemoveWorktree(git, currentPath)
            return
          }
        }
      }
    } catch {
      // best effort — prune may handle it
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
/*  Package manager detection                                          */
/* ------------------------------------------------------------------ */

interface InstallCommand {
  name: string
  command: string
}

/**
 * Detect package managers from lockfiles / manifests in the project.
 * Returns install commands in priority order.
 */
function detectInstallCommands(projectPath: string): InstallCommand[] {
  const commands: InstallCommand[] = []

  // Node.js — detect from lockfile (most specific wins)
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) {
    commands.push({ name: 'pnpm', command: 'pnpm install --frozen-lockfile' })
  } else if (
    existsSync(join(projectPath, 'bun.lockb')) ||
    existsSync(join(projectPath, 'bun.lock'))
  ) {
    commands.push({ name: 'bun', command: 'bun install --frozen-lockfile' })
  } else if (existsSync(join(projectPath, 'yarn.lock'))) {
    commands.push({ name: 'yarn', command: 'yarn install --frozen-lockfile' })
  } else if (existsSync(join(projectPath, 'package-lock.json'))) {
    commands.push({ name: 'npm', command: 'npm ci' })
  } else if (existsSync(join(projectPath, 'package.json'))) {
    commands.push({ name: 'npm', command: 'npm install' })
  }

  // Python
  if (existsSync(join(projectPath, 'requirements.txt'))) {
    commands.push({ name: 'pip', command: 'pip install -r requirements.txt -q' })
  } else if (existsSync(join(projectPath, 'pyproject.toml'))) {
    if (existsSync(join(projectPath, 'poetry.lock'))) {
      commands.push({ name: 'poetry', command: 'poetry install --no-interaction' })
    } else if (existsSync(join(projectPath, 'uv.lock'))) {
      commands.push({ name: 'uv', command: 'uv sync' })
    }
  }

  // Ruby
  if (existsSync(join(projectPath, 'Gemfile.lock'))) {
    commands.push({ name: 'bundler', command: 'bundle install --quiet' })
  }

  // PHP
  if (existsSync(join(projectPath, 'composer.lock'))) {
    commands.push({ name: 'composer', command: 'composer install --no-interaction --quiet' })
  }

  // iOS (CocoaPods)
  if (existsSync(join(projectPath, 'Podfile.lock'))) {
    commands.push({ name: 'cocoapods', command: 'pod install' })
  }

  return commands
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build `-c http.extraHeader=Authorization: Basic ...` args for GitHub repos.
 * Returns an empty array for non-GitHub repos or when no token is available.
 */
async function getGitHubAuthArgs(projectPath: string): Promise<string[]> {
  try {
    const info = await detectRepo(projectPath)
    if (!info.host.includes('github') || !info.owner) return []

    const { getGitHubClient } = await import('../github/client.js')
    const client = await getGitHubClient()
    const token = await client.getToken(info.owner, info.repo)
    if (!token) return []

    const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basicAuth}`]
  } catch {
    return []
  }
}

/**
 * Push a branch with GitHub App auth if available, falling back to plain push.
 */
async function authenticatedPush(
  worktreePath: string,
  branchName: string,
  projectPath: string,
): Promise<void> {
  const git = simpleGit(worktreePath)
  try {
    const info = await detectRepo(projectPath)
    if (info.host.includes('github') && info.owner) {
      const { getGitHubClient } = await import('../github/client.js')
      const client = await getGitHubClient()
      const token = await client.getToken(info.owner, info.repo)
      if (token) {
        const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64')
        const httpsRemote = `https://${info.host}/${info.owner}/${info.repo}.git`
        await git.raw([
          '-c',
          `http.extraHeader=Authorization: Basic ${basicAuth}`,
          'push',
          '--set-upstream',
          httpsRemote,
          branchName,
        ])
        return
      }
    }
  } catch {
    // Fall through to plain push
  }
  await git.push(['--set-upstream', 'origin', branchName])
}

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

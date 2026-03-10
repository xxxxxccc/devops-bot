/**
 * Repository Manager — clone and sync git repositories.
 *
 * Managed repos live under a configurable base directory (default: ~/.devops-bot/repos/).
 * Each repo gets a path like: {baseDir}/{host}/{owner}/{repo}/
 *
 * For GitHub repos: uses authenticated HTTPS URL when GitHub App is configured.
 * For other platforms: relies on existing git credentials (SSH / credential helper).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { type SimpleGitOptions, simpleGit } from 'simple-git'
import { createLogger } from '../infra/logger.js'

const log = createLogger('repo-manager')

const DEFAULT_BASE_DIR = join(homedir(), '.devops-bot', 'repos')

const GIT_TIMEOUT = { block: 60_000 }
const GIT_CLONE_TIMEOUT = { block: 300_000 }

function git(baseDir?: string): ReturnType<typeof simpleGit> {
  const opts: Partial<SimpleGitOptions> = baseDir ? { baseDir } : {}
  return simpleGit(opts).timeout(GIT_TIMEOUT)
}

function gitClone(): ReturnType<typeof simpleGit> {
  return simpleGit().timeout(GIT_CLONE_TIMEOUT)
}

export interface ParsedGitUrl {
  host: string
  owner: string
  repo: string
}

/**
 * Parse a git URL (SSH or HTTPS) into host/owner/repo components.
 */
export function parseGitUrl(url: string): ParsedGitUrl | undefined {
  const trimmed = url.trim()

  // SSH: git@host:owner/repo.git
  const sshMatch = trimmed.match(/git@([^:]+):([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (sshMatch) return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] }

  // HTTPS: https://[user:pass@]host/owner/repo.git — strip optional credentials
  const httpsMatch = trimmed.match(/https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (httpsMatch) return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] }

  return undefined
}

/**
 * Derive a project ID from a git URL (e.g. "github.com/org/repo").
 */
export function gitUrlToProjectId(url: string): string | undefined {
  const parsed = parseGitUrl(url)
  if (!parsed) return undefined
  return `${parsed.host}/${parsed.owner}/${parsed.repo}`
}

export class RepoManager {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir || process.env.REPOS_BASE_DIR || DEFAULT_BASE_DIR
    mkdirSync(this.baseDir, { recursive: true })
  }

  /**
   * Compute the local path for a repository based on its URL.
   */
  localPathFor(gitUrl: string): string | undefined {
    const parsed = parseGitUrl(gitUrl)
    if (!parsed) return undefined
    return join(this.baseDir, parsed.host, parsed.owner, parsed.repo)
  }

  /**
   * Ensure a repository is cloned locally. If already cloned, returns the path.
   * Returns the local path on success, undefined on failure.
   */
  async ensureRepo(gitUrl: string): Promise<string | undefined> {
    const localPath = this.localPathFor(gitUrl)
    if (!localPath) {
      log.error('Cannot parse git URL', { gitUrl })
      return undefined
    }

    if (existsSync(join(localPath, '.git'))) {
      log.info('Repository already cloned', { gitUrl, localPath })
      return localPath
    }

    mkdirSync(localPath, { recursive: true })

    try {
      log.info('Cloning repository', { gitUrl, localPath })
      const g = gitClone()
      const authHeader = await this.getAuthHeader(gitUrl)

      if (authHeader) {
        await g.raw([
          '-c',
          `http.extraHeader=${authHeader}`,
          'clone',
          '--single-branch',
          gitUrl,
          localPath,
        ])
      } else {
        await g.clone(gitUrl, localPath, ['--single-branch'])
      }

      log.info('Clone complete', { localPath })
      return localPath
    } catch (err) {
      log.error('Clone failed', {
        gitUrl,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * Sync a local repository to the latest remote state.
   * Fetches and hard-resets to origin/default_branch.
   */
  async syncRepo(localPath: string, defaultBranch = 'main', gitUrl?: string): Promise<boolean> {
    try {
      const g = git(localPath)
      const authHeader = gitUrl ? await this.getAuthHeader(gitUrl) : undefined

      if (authHeader) {
        await g.raw(['-c', `http.extraHeader=${authHeader}`, 'fetch', 'origin', '--prune'])
      } else {
        await g.fetch(['origin', '--prune'])
      }

      await g.reset(['--hard', `origin/${defaultBranch}`])

      try {
        await g.raw(['submodule', 'update', '--init', '--recursive'])
      } catch {
        // No submodules or update failed — not fatal for the main repo sync
      }

      log.info('Repository synced', { localPath, branch: defaultBranch })
      return true
    } catch (err) {
      log.error('Sync failed', {
        localPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /**
   * Detect the default branch of a local repository.
   */
  async detectDefaultBranch(localPath: string): Promise<string> {
    try {
      const g = git(localPath)
      const remote = await g.raw(['remote', 'show', 'origin'])
      const match = remote.match(/HEAD branch:\s*(.+)/)
      return match?.[1]?.trim() || 'main'
    } catch {
      return 'main'
    }
  }

  /**
   * Build an HTTP Authorization header for GitHub repos when App is configured.
   * Returns undefined for non-GitHub repos or when no token is available.
   */
  private async getAuthHeader(gitUrl: string): Promise<string | undefined> {
    const parsed = parseGitUrl(gitUrl)
    if (!parsed) return undefined

    if (parsed.host.includes('github')) {
      try {
        const { getGitHubClient } = await import('../github/client.js')
        const client = await getGitHubClient()
        const token = await client.getToken(parsed.owner, parsed.repo)
        if (token) {
          const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64')
          return `Authorization: Basic ${basicAuth}`
        }
      } catch {
        // Fall through — no auth header
      }
    }

    return undefined
  }
}

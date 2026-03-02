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
import { simpleGit } from 'simple-git'
import { createLogger } from '../infra/logger.js'

const log = createLogger('repo-manager')

const DEFAULT_BASE_DIR = join(homedir(), '.devops-bot', 'repos')

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

  // HTTPS: https://host/owner/repo.git or https://host/owner/repo
  const httpsMatch = trimmed.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?$/)
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

    const cloneUrl = await this.getCloneUrl(gitUrl)
    mkdirSync(localPath, { recursive: true })

    try {
      log.info('Cloning repository', { gitUrl, localPath })
      const git = simpleGit()
      await git.clone(cloneUrl, localPath, ['--single-branch'])
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
  async syncRepo(localPath: string, defaultBranch = 'main'): Promise<boolean> {
    try {
      const git = simpleGit(localPath)
      await git.fetch(['origin', '--prune'])
      await git.reset(['--hard', `origin/${defaultBranch}`])
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
      const git = simpleGit(localPath)
      const remote = await git.raw(['remote', 'show', 'origin'])
      const match = remote.match(/HEAD branch:\s*(.+)/)
      return match?.[1]?.trim() || 'main'
    } catch {
      return 'main'
    }
  }

  /**
   * Get clone URL, using authenticated HTTPS for GitHub repos when App is configured.
   */
  private async getCloneUrl(gitUrl: string): Promise<string> {
    const parsed = parseGitUrl(gitUrl)
    if (!parsed) return gitUrl

    if (parsed.host.includes('github')) {
      try {
        const { getGitHubClient } = await import('../github/client.js')
        const client = await getGitHubClient()
        const authUrl = await client.getAuthenticatedRemoteUrl(
          parsed.owner,
          parsed.repo,
          parsed.host,
        )
        if (authUrl) return authUrl
      } catch {
        // Fall through to original URL
      }
    }

    return gitUrl
  }
}

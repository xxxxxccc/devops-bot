/**
 * PR Creator — auto-detect git hosting platform and create PR/MR.
 *
 * Detects GitHub vs GitLab from the remote URL, then uses the
 * appropriate CLI tool (`gh` / `glab`) to create a pull/merge request.
 */

import { execSync } from 'node:child_process'
import { simpleGit } from 'simple-git'
import { createLogger } from '../infra/logger.js'

const log = createLogger('pr-creator')

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type GitPlatform = 'github' | 'gitlab' | 'unknown'

export interface PROptions {
  projectPath: string
  branchName: string
  baseBranch: string
  title: string
  description?: string
  draft?: boolean
}

/* ------------------------------------------------------------------ */
/*  Platform detection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Detect the git hosting platform from the remote URL.
 */
async function detectPlatform(projectPath: string): Promise<GitPlatform> {
  try {
    const git = simpleGit(projectPath)
    const remoteUrl = await git.remote(['get-url', 'origin'])
    if (!remoteUrl) return 'unknown'

    const url = remoteUrl.trim().toLowerCase()
    if (url.includes('github.com') || url.includes('github.')) return 'github'
    if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a CLI tool is available on PATH.
 */
function hasCliTool(name: string): boolean {
  try {
    execSync(`${name} --version`, { stdio: 'pipe', encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/*  PR creation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Create a PR/MR on the detected platform.
 * Returns the PR URL if successful, null otherwise.
 */
export async function createPullRequest(opts: PROptions): Promise<string | null> {
  const platform = await detectPlatform(opts.projectPath)

  log.info('Creating PR', {
    platform,
    branch: opts.branchName,
    base: opts.baseBranch,
    draft: opts.draft,
  })

  switch (platform) {
    case 'github':
      return createGitHubPR(opts)
    case 'gitlab':
      return createGitLabMR(opts)
    default:
      log.warn('Unknown git platform, skipping PR creation')
      return null
  }
}

/**
 * Create a GitHub Pull Request using `gh` CLI.
 */
async function createGitHubPR(opts: PROptions): Promise<string | null> {
  if (!hasCliTool('gh')) {
    log.warn('gh CLI not found, skipping GitHub PR creation')
    return null
  }

  const args = [
    'gh',
    'pr',
    'create',
    '--head',
    opts.branchName,
    '--base',
    opts.baseBranch,
    '--title',
    JSON.stringify(opts.title),
    '--body',
    JSON.stringify(buildPRBody(opts)),
  ]
  if (opts.draft) args.push('--draft')

  try {
    const result = execSync(args.join(' '), {
      cwd: opts.projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()

    // gh pr create prints the PR URL on success
    const urlMatch = result.match(/https?:\/\/\S+/)
    const prUrl = urlMatch?.[0] ?? result
    log.info('GitHub PR created', { url: prUrl })
    return prUrl
  } catch (error) {
    log.error('Failed to create GitHub PR', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Create a GitLab Merge Request using `glab` CLI.
 */
async function createGitLabMR(opts: PROptions): Promise<string | null> {
  if (!hasCliTool('glab')) {
    log.warn('glab CLI not found, skipping GitLab MR creation')
    return null
  }

  const args = [
    'glab',
    'mr',
    'create',
    '--source-branch',
    opts.branchName,
    '--target-branch',
    opts.baseBranch,
    '--title',
    JSON.stringify(opts.title),
    '--description',
    JSON.stringify(buildPRBody(opts)),
    '--no-editor',
  ]
  if (opts.draft) args.push('--draft')

  try {
    const result = execSync(args.join(' '), {
      cwd: opts.projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()

    const urlMatch = result.match(/https?:\/\/\S+/)
    const mrUrl = urlMatch?.[0] ?? result
    log.info('GitLab MR created', { url: mrUrl })
    return mrUrl
  } catch (error) {
    log.error('Failed to create GitLab MR', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildPRBody(opts: PROptions): string {
  const lines = [
    '## Summary',
    '',
    opts.description || opts.title,
    '',
    '---',
    '_This PR was automatically created by DevOps Bot._',
  ]
  return lines.join('\n')
}

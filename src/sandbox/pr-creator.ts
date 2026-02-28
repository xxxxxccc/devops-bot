/**
 * PR Creator — auto-detect git hosting platform and create PR/MR.
 *
 * Platform strategies:
 *
 *   GitLab:  Push with `-o merge_request.create` options — zero extra config,
 *            leverages the same git credentials used for push.
 *            Falls back to REST API (GITLAB_TOKEN) or `glab` CLI.
 *
 *   GitHub:  REST API (GITHUB_TOKEN) → `gh` CLI → clear error message.
 *            GitHub has no push-option equivalent for PRs.
 *
 * Supports GitHub Enterprise and self-hosted GitLab (host extracted from remote URL).
 */

import { execFileSync, execSync } from 'node:child_process'
import { simpleGit } from 'simple-git'
import { createLogger } from '../infra/logger.js'

const log = createLogger('pr-creator')

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type GitPlatform = 'github' | 'gitlab' | 'unknown'

export interface PROptions {
  /** Path to the git working directory (worktree or project root) */
  worktreePath: string
  /** Original project path (for platform detection from remote URL) */
  projectPath: string
  branchName: string
  baseBranch: string
  title: string
  description?: string
  draft?: boolean
}

export interface RepoInfo {
  platform: GitPlatform
  /** Host for API calls (e.g. "github.com", "gitlab.company.com") */
  host: string
  owner: string
  repo: string
}

/* ------------------------------------------------------------------ */
/*  Platform detection                                                 */
/* ------------------------------------------------------------------ */

const UNKNOWN_REPO: RepoInfo = { platform: 'unknown', host: '', owner: '', repo: '' }

export async function detectRepo(projectPath: string): Promise<RepoInfo> {
  try {
    const git = simpleGit(projectPath)
    const remoteUrl = await git.remote(['get-url', 'origin'])
    if (!remoteUrl) return UNKNOWN_REPO

    const url = remoteUrl.trim()

    // SSH: git@host:owner/repo.git
    const sshMatch = url.match(/git@([^:]+):([^/]+)\/([^/.]+)/)
    if (sshMatch) return classifyHost(sshMatch[1], sshMatch[2], sshMatch[3])

    // HTTPS: https://host/owner/repo.git
    const httpsMatch = url.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/.]+)/)
    if (httpsMatch) return classifyHost(httpsMatch[1], httpsMatch[2], httpsMatch[3])

    return UNKNOWN_REPO
  } catch {
    return UNKNOWN_REPO
  }
}

function classifyHost(rawHost: string, owner: string, repo: string): RepoInfo {
  const host = rawHost.toLowerCase()
  if (host.includes('github')) return { platform: 'github', host, owner, repo }
  if (host.includes('gitlab')) return { platform: 'gitlab', host, owner, repo }
  return { platform: 'unknown', host, owner, repo }
}

/* ------------------------------------------------------------------ */
/*  Push + PR (combined entry point)                                   */
/* ------------------------------------------------------------------ */

/**
 * Push the branch and create a PR/MR in a single flow.
 *
 * For GitLab this is literally one `git push` with push options.
 * For GitHub the push and PR creation are separate steps.
 *
 * Returns the PR/MR URL if created, undefined otherwise.
 */
export async function pushAndCreatePR(opts: PROptions): Promise<string | undefined> {
  const info = await detectRepo(opts.projectPath)

  log.info('Finalizing branch', {
    platform: info.platform,
    host: info.host,
    branch: opts.branchName,
    base: opts.baseBranch,
  })

  switch (info.platform) {
    case 'gitlab':
      return gitlabPushWithMR(opts, info)
    case 'github':
      return githubPushThenPR(opts, info)
    default:
      // Unknown platform — just push, skip PR
      await plainPush(opts)
      log.warn('Unknown git platform, branch pushed but no PR created')
      return undefined
  }
}

/**
 * Push-only (no PR creation). Used when autoCreatePR is disabled.
 */
export async function pushOnly(
  opts: Pick<PROptions, 'worktreePath' | 'branchName'>,
): Promise<void> {
  await plainPush(opts)
}

/* ------------------------------------------------------------------ */
/*  GitLab — push with merge request options                           */
/* ------------------------------------------------------------------ */

async function gitlabPushWithMR(opts: PROptions, info: RepoInfo): Promise<string | undefined> {
  // Strategy 1: git push -o merge_request.create (zero config!)
  const mrUrl = pushWithMROptions(opts)
  if (mrUrl) return mrUrl

  // Strategy 2: plain push + API
  await plainPush(opts)

  const token = getGitLabToken()
  if (token) {
    const url = await createGitLabMRViaAPI(opts, info, token)
    if (url) return url
    log.warn('GitLab API MR creation failed, trying glab CLI')
  }

  // Strategy 3: glab CLI
  if (hasCliTool('glab')) {
    return runCLI(
      'glab',
      [
        'mr',
        'create',
        '--source-branch',
        opts.branchName,
        '--target-branch',
        opts.baseBranch,
        '--title',
        opts.title,
        '--description',
        buildBody(opts),
        '--no-editor',
        ...(opts.draft ? ['--draft'] : []),
      ],
      opts.worktreePath,
    )
  }

  log.warn('Branch pushed but MR creation failed (push options rejected and no GITLAB_TOKEN/glab)')
  return undefined
}

/**
 * Push with GitLab push options to create MR in one step.
 * Returns the MR URL parsed from the push output, or undefined on failure.
 */
function pushWithMROptions(opts: PROptions): string | undefined {
  const pushArgs = [
    'push',
    '--set-upstream',
    'origin',
    opts.branchName,
    '-o',
    'merge_request.create',
    '-o',
    `merge_request.target=${opts.baseBranch}`,
    '-o',
    `merge_request.title=${opts.title}`,
  ]

  if (opts.draft) {
    pushArgs.push('-o', 'merge_request.draft')
  }

  const body = buildBody(opts)
  if (body.length <= 1024) {
    pushArgs.push('-o', `merge_request.description=${body}`)
  }

  try {
    log.info('Pushing with GitLab MR push options')
    const result = execFileSync('git', pushArgs, {
      cwd: opts.worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    })

    // GitLab prints the MR URL in stderr during push
    const urlMatch = result.match(/https?:\/\/\S+merge_requests\/\d+/)
    if (urlMatch) {
      log.info('GitLab MR created via push options', { url: urlMatch[0] })
      return urlMatch[0]
    }

    log.info('Push succeeded but no MR URL found in output, MR may have been created')
    return undefined
  } catch (error) {
    // execFileSync captures stderr in the error object
    const err = error as { stderr?: string; stdout?: string; message?: string }
    const combined = `${err.stdout || ''}${err.stderr || ''}`
    const urlMatch = combined.match(/https?:\/\/\S+merge_requests\/\d+/)
    if (urlMatch) {
      log.info('GitLab MR created via push options', { url: urlMatch[0] })
      return urlMatch[0]
    }

    log.warn('Push with MR options failed, will try alternative methods', {
      error: err.message?.slice(0, 300),
    })
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub — push then create PR                                       */
/* ------------------------------------------------------------------ */

async function githubPushThenPR(opts: PROptions, info: RepoInfo): Promise<string | undefined> {
  await plainPush(opts)

  // Strategy 1: REST API
  const token = getGitHubToken()
  if (token) {
    const url = await createGitHubPRViaAPI(opts, info, token)
    if (url) return url
    log.warn('GitHub API PR creation failed, trying gh CLI')
  }

  // Strategy 2: gh CLI
  if (hasCliTool('gh')) {
    const url = runCLI(
      'gh',
      [
        'pr',
        'create',
        '--head',
        opts.branchName,
        '--base',
        opts.baseBranch,
        '--title',
        opts.title,
        '--body',
        buildBody(opts),
        ...(opts.draft ? ['--draft'] : []),
      ],
      opts.worktreePath,
    )
    if (url) return url
  }

  log.error(
    'Branch pushed but PR creation failed. ' +
      'Set GITHUB_TOKEN in .env.local or install/authenticate gh CLI (https://cli.github.com)',
  )
  return undefined
}

/* ------------------------------------------------------------------ */
/*  REST API implementations                                           */
/* ------------------------------------------------------------------ */

async function createGitHubPRViaAPI(
  opts: PROptions,
  info: RepoInfo,
  token: string,
): Promise<string | undefined> {
  const apiBase =
    info.host === 'github.com' ? 'https://api.github.com' : `https://${info.host}/api/v3`

  return apiPost(`${apiBase}/repos/${info.owner}/${info.repo}/pulls`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: {
      title: opts.title,
      body: buildBody(opts),
      head: opts.branchName,
      base: opts.baseBranch,
      draft: opts.draft ?? false,
    },
    urlField: 'html_url',
    label: 'GitHub API',
  })
}

async function createGitLabMRViaAPI(
  opts: PROptions,
  info: RepoInfo,
  token: string,
): Promise<string | undefined> {
  const apiBase = `https://${info.host}/api/v4`
  const projectId = encodeURIComponent(`${info.owner}/${info.repo}`)

  return apiPost(`${apiBase}/projects/${projectId}/merge_requests`, {
    headers: { 'PRIVATE-TOKEN': token },
    body: {
      title: opts.title,
      description: buildBody(opts),
      source_branch: opts.branchName,
      target_branch: opts.baseBranch,
      ...(opts.draft ? { draft: true } : {}),
    },
    urlField: 'web_url',
    label: 'GitLab API',
  })
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

async function plainPush(opts: Pick<PROptions, 'worktreePath' | 'branchName'>): Promise<void> {
  const git = simpleGit(opts.worktreePath)
  await git.push(['--set-upstream', 'origin', opts.branchName])
}

function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined
}

function getGitLabToken(): string | undefined {
  return (
    process.env.GITLAB_TOKEN ||
    process.env.GITLAB_PRIVATE_TOKEN ||
    process.env.GL_TOKEN ||
    undefined
  )
}

function hasCliTool(name: string): boolean {
  try {
    execSync(`${name} --version`, { stdio: 'pipe', encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

function runCLI(tool: string, args: string[], cwd: string): string | undefined {
  try {
    const result = execFileSync(tool, args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()

    const urlMatch = result.match(/https?:\/\/\S+/)
    const url = urlMatch?.[0] ?? result
    log.info(`PR created via ${tool} CLI`, { url })
    return url || undefined
  } catch (error) {
    log.error(`${tool} CLI failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

interface ApiPostOpts {
  headers: Record<string, string>
  body: Record<string, unknown>
  urlField: string
  label: string
}

async function apiPost(url: string, opts: ApiPostOpts): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...opts.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body),
    })

    if (!response.ok) {
      const errBody = await response.text()
      log.error(`${opts.label} error`, { status: response.status, body: errBody.slice(0, 500) })
      return undefined
    }

    const data = (await response.json()) as Record<string, unknown>
    const prUrl = data[opts.urlField]
    if (typeof prUrl === 'string') {
      log.info(`PR created via ${opts.label}`, { url: prUrl })
      return prUrl
    }

    log.warn(`${opts.label} response missing ${opts.urlField}`)
    return undefined
  } catch (error) {
    log.error(`${opts.label} request failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

function buildBody(opts: PROptions): string {
  return [
    '## Summary',
    '',
    opts.description || opts.title,
    '',
    '---',
    '_This PR was automatically created by DevOps Bot._',
  ].join('\n')
}

/**
 * Issue Creator — create GitHub Issues / GitLab Issues via REST API or CLI.
 *
 * Reuses platform detection from pr-creator.ts.
 * Strategies mirror pr-creator: API (token) → CLI fallback → clear error.
 */

import { execFileSync } from 'node:child_process'
import { createLogger } from '../infra/logger.js'
import { type RepoInfo, detectRepo } from './pr-creator.js'

const log = createLogger('issue-creator')

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface IssueOptions {
  projectPath: string
  title: string
  body: string
  labels?: string[]
}

export interface CreatedIssue {
  url: string
  number: number
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Create an issue on the detected git platform.
 * Returns the issue URL + number, or undefined if creation failed.
 */
export async function createIssue(opts: IssueOptions): Promise<CreatedIssue | undefined> {
  const info = await detectRepo(opts.projectPath)

  log.info('Creating issue', { platform: info.platform, title: opts.title })

  switch (info.platform) {
    case 'github':
      return createGitHubIssue(opts, info)
    case 'gitlab':
      return createGitLabIssue(opts, info)
    default:
      log.warn('Unknown git platform, cannot create issue')
      return undefined
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub                                                             */
/* ------------------------------------------------------------------ */

async function createGitHubIssue(
  opts: IssueOptions,
  info: RepoInfo,
): Promise<CreatedIssue | undefined> {
  // Strategy 1: GitHub Client (App token or PAT)
  const { getGitHubClient } = await import('../github/client.js')
  const client = await getGitHubClient()
  if (client.isAvailable) {
    const result = await client.createIssue(
      info.owner,
      info.repo,
      { title: opts.title, body: opts.body, labels: opts.labels },
      info.host,
    )
    if (result) return result
    log.warn('GitHub Client issue creation failed, trying gh CLI')
  }

  // Strategy 2: gh CLI
  if (hasCliTool('gh')) {
    return createGitHubIssueViaCLI(opts)
  }

  log.warn('Cannot create GitHub issue: no GITHUB_APP_ID/GITHUB_TOKEN and no gh CLI')
  return undefined
}

function createGitHubIssueViaCLI(opts: IssueOptions): CreatedIssue | undefined {
  try {
    const args = ['issue', 'create', '--title', opts.title, '--body', opts.body]
    if (opts.labels?.length) {
      args.push('--label', opts.labels.join(','))
    }

    const result = execFileSync('gh', args, {
      cwd: opts.projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()

    const urlMatch = result.match(/https?:\/\/\S+/)
    if (urlMatch) {
      const numberMatch = urlMatch[0].match(/\/issues\/(\d+)/)
      const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : 0
      log.info('Issue created via gh CLI', { url: urlMatch[0], number })
      return { url: urlMatch[0], number }
    }

    return undefined
  } catch (error) {
    log.error('gh CLI issue creation failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/*  GitLab                                                             */
/* ------------------------------------------------------------------ */

async function createGitLabIssue(
  opts: IssueOptions,
  info: RepoInfo,
): Promise<CreatedIssue | undefined> {
  const token = process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN || process.env.GL_TOKEN
  if (token) {
    const result = await createGitLabIssueViaAPI(opts, info, token)
    if (result) return result
    log.warn('GitLab API issue creation failed, trying glab CLI')
  }

  if (hasCliTool('glab')) {
    return createGitLabIssueViaCLI(opts)
  }

  log.warn('Cannot create GitLab issue: no GITLAB_TOKEN and no glab CLI')
  return undefined
}

async function createGitLabIssueViaAPI(
  opts: IssueOptions,
  info: RepoInfo,
  token: string,
): Promise<CreatedIssue | undefined> {
  const apiBase = `https://${info.host}/api/v4`
  const projectId = encodeURIComponent(`${info.owner}/${info.repo}`)
  const url = `${apiBase}/projects/${projectId}/issues`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: opts.title,
        description: opts.body,
        labels: opts.labels?.join(','),
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      log.error('GitLab API issue creation error', {
        status: response.status,
        body: errBody.slice(0, 500),
      })
      return undefined
    }

    const data = (await response.json()) as { web_url?: string; iid?: number }
    if (data.web_url && data.iid) {
      log.info('Issue created via GitLab API', { url: data.web_url, number: data.iid })
      return { url: data.web_url, number: data.iid }
    }

    log.warn('GitLab API response missing web_url or iid')
    return undefined
  } catch (error) {
    log.error('GitLab API issue request failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

function createGitLabIssueViaCLI(opts: IssueOptions): CreatedIssue | undefined {
  try {
    const args = [
      'issue',
      'create',
      '--title',
      opts.title,
      '--description',
      opts.body,
      '--no-editor',
    ]
    if (opts.labels?.length) {
      args.push('--label', opts.labels.join(','))
    }

    const result = execFileSync('glab', args, {
      cwd: opts.projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()

    const urlMatch = result.match(/https?:\/\/\S+/)
    if (urlMatch) {
      const numberMatch = urlMatch[0].match(/\/issues\/(\d+)/)
      const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : 0
      log.info('Issue created via glab CLI', { url: urlMatch[0], number })
      return { url: urlMatch[0], number }
    }

    return undefined
  } catch (error) {
    log.error('glab CLI issue creation failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function hasCliTool(name: string): boolean {
  try {
    execFileSync(name, ['--version'], { stdio: 'pipe', encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

/**
 * Build a standard issue body from task context.
 */
export function buildIssueBody(opts: {
  description: string
  createdBy?: string
  labels?: string[]
}): string {
  const lines: string[] = []

  if (opts.createdBy) {
    lines.push(`**Requested by:** ${opts.createdBy}`, '')
  }

  lines.push('## Description', '', opts.description, '')
  lines.push('---', '_This issue was automatically created by DevOps Bot._')

  return lines.join('\n')
}

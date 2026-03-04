/**
 * GitHub Client — unified API client using GitHub App or PAT authentication.
 *
 * Provides typed wrappers for common GitHub API operations (PRs, Issues, etc.)
 * and an authenticated git remote URL for push operations.
 *
 * Authentication priority:
 *   1. GitHub App (installation token) — if GITHUB_APP_ID is configured
 *   2. Personal Access Token (GITHUB_TOKEN / GH_TOKEN) — fallback
 */

import { createLogger } from '../infra/logger.js'
import type { GitHubAppAuth } from './app-auth.js'

const log = createLogger('github-client')

export interface GitHubPROptions {
  title: string
  body: string
  head: string
  base: string
  draft?: boolean
}

export interface GitHubIssueOptions {
  title: string
  body: string
  labels?: string[]
}

export interface GitHubCreatedResource {
  url: string
  number: number
}

export class GitHubClient {
  private appAuth: GitHubAppAuth | null
  private patToken: string | undefined
  /** HTTP status from the most recent apiGet call (for 404 detection). */
  private lastStatus = 0

  constructor(appAuth: GitHubAppAuth | null) {
    this.appAuth = appAuth
    this.patToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined
  }

  get isAvailable(): boolean {
    return this.appAuth !== null || this.patToken !== undefined
  }

  /**
   * Get an authorization token for a specific owner/repo.
   * Uses App installation token if available, otherwise PAT.
   */
  async getToken(owner: string, repo: string): Promise<string | undefined> {
    if (this.appAuth) {
      try {
        return await this.appAuth.getInstallationToken(owner, repo)
      } catch (err) {
        log.warn('App token failed, falling back to PAT', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return this.patToken
  }

  /**
   * Get an authenticated HTTPS remote URL for git push.
   * Returns undefined if no token is available.
   */
  async getAuthenticatedRemoteUrl(
    owner: string,
    repo: string,
    host = 'github.com',
  ): Promise<string | undefined> {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined
    return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`
  }

  async createPR(
    owner: string,
    repo: string,
    opts: GitHubPROptions,
    host = 'github.com',
  ): Promise<GitHubCreatedResource | undefined> {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    return this.apiPost<GitHubCreatedResource>(
      `${apiBase}/repos/${owner}/${repo}/pulls`,
      token,
      {
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft ?? false,
      },
      (data) => ({
        url: data.html_url as string,
        number: data.number as number,
      }),
      'createPR',
    )
  }

  async createIssue(
    owner: string,
    repo: string,
    opts: GitHubIssueOptions,
    host = 'github.com',
  ): Promise<GitHubCreatedResource | undefined> {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    return this.apiPost<GitHubCreatedResource>(
      `${apiBase}/repos/${owner}/${repo}/issues`,
      token,
      {
        title: opts.title,
        body: opts.body,
        labels: opts.labels ?? [],
      },
      (data) => ({
        url: data.html_url as string,
        number: data.number as number,
      }),
      'createIssue',
    )
  }

  /** List reactions on an issue. Returns content + user login. */
  async listIssueReactions(
    owner: string,
    repo: string,
    issueNumber: number,
    host = 'github.com',
  ): Promise<Array<{ content: string; user: string }>> {
    const token = await this.getToken(owner, repo)
    if (!token) return []

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const url = `${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/reactions?per_page=100`

    const data = await this.apiGet<Array<{ content: string; user: { login: string } }>>(
      url,
      token,
      'listIssueReactions',
    )
    if (!data) return []
    return data.map((r) => ({ content: r.content, user: r.user?.login ?? '' }))
  }

  /**
   * Fetch an issue's state, body, and all comments.
   * Used to build the full discussion context when an approval is detected.
   * Returns `{ notFound: true }` when the issue has been deleted (404/410).
   */
  async getIssueWithComments(
    owner: string,
    repo: string,
    issueNumber: number,
    host = 'github.com',
  ): Promise<
    | {
        notFound?: false
        state: string
        body: string
        comments: Array<{ user: string; body: string; createdAt: string }>
      }
    | { notFound: true }
    | undefined
  > {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    const issue = await this.apiGet<{ state: string; body: string | null }>(
      `${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}`,
      token,
      'getIssue',
    )
    if (!issue) {
      if (this.lastStatus === 404 || this.lastStatus === 410) return { notFound: true }
      return undefined
    }

    const rawComments =
      (await this.apiGet<
        Array<{ user: { login: string } | null; body: string | null; created_at: string }>
      >(
        `${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
        token,
        'getIssueComments',
      )) ?? []

    return {
      state: issue.state ?? 'open',
      body: issue.body ?? '',
      comments: rawComments
        .filter((c): c is typeof c & {} => c != null)
        .map((c) => ({
          user: c.user?.login ?? 'unknown',
          body: c.body ?? '',
          createdAt: c.created_at ?? '',
        })),
    }
  }

  /** List open issues filtered by label. Returns issue number, title, and labels. */
  async listOpenIssuesWithLabel(
    owner: string,
    repo: string,
    label: string,
    host = 'github.com',
  ): Promise<Array<{ number: number; title: string; labels: string[]; html_url: string }>> {
    const token = await this.getToken(owner, repo)
    if (!token) return []

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const url = `${apiBase}/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=30`

    const data = await this.apiGet<
      Array<{
        number: number
        title: string
        labels: Array<{ name: string }>
        html_url: string
        pull_request?: unknown
      }>
    >(url, token, 'listOpenIssuesWithLabel')

    if (!data) return []
    return data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: (i.labels ?? []).map((l) => l.name),
        html_url: i.html_url,
      }))
  }

  /** Post a comment on an issue. */
  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
    host = 'github.com',
  ): Promise<boolean> {
    const token = await this.getToken(owner, repo)
    if (!token) return false

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    const result = await this.apiPost(
      `${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      token,
      { body },
      () => ({}),
      'createIssueComment',
    )
    return result !== undefined
  }

  /** List issues with optional state and label filters. */
  async listIssues(
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; labels?: string; per_page?: number } = {},
    host = 'github.com',
  ): Promise<
    Array<{
      number: number
      title: string
      state: string
      labels: string[]
      html_url: string
      created_at: string
      user: string
    }>
  > {
    const token = await this.getToken(owner, repo)
    if (!token) return []

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const params = new URLSearchParams({
      state: opts.state || 'open',
      per_page: String(opts.per_page || 30),
    })
    if (opts.labels) params.set('labels', opts.labels)

    const data = await this.apiGet<
      Array<{
        number: number
        title: string
        state: string
        labels: Array<{ name: string }>
        html_url: string
        created_at: string
        user: { login: string } | null
        pull_request?: unknown
      }>
    >(`${apiBase}/repos/${owner}/${repo}/issues?${params}`, token, 'listIssues')

    if (!data) return []
    return data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        labels: (i.labels ?? []).map((l) => l.name),
        html_url: i.html_url,
        created_at: i.created_at,
        user: i.user?.login ?? 'unknown',
      }))
  }

  /** Update an issue's state, title, or body. */
  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    opts: { state?: 'open' | 'closed'; title?: string; body?: string },
    host = 'github.com',
  ): Promise<boolean> {
    const token = await this.getToken(owner, repo)
    if (!token) return false

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    return this.apiPatch(
      `${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}`,
      token,
      opts,
      'updateIssue',
    )
  }

  /** List pull requests with optional state filter. */
  async listPRs(
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; per_page?: number } = {},
    host = 'github.com',
  ): Promise<
    Array<{
      number: number
      title: string
      state: string
      html_url: string
      user: string
      head: string
      base: string
      draft: boolean
      labels: string[]
      created_at: string
    }>
  > {
    const token = await this.getToken(owner, repo)
    if (!token) return []

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const params = new URLSearchParams({
      state: opts.state || 'open',
      per_page: String(opts.per_page || 30),
    })

    const data = await this.apiGet<
      Array<{
        number: number
        title: string
        state: string
        html_url: string
        user: { login: string } | null
        head: { ref: string }
        base: { ref: string }
        draft: boolean
        labels: Array<{ name: string }>
        created_at: string
      }>
    >(`${apiBase}/repos/${owner}/${repo}/pulls?${params}`, token, 'listPRs')

    if (!data) return []
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      html_url: pr.html_url,
      user: pr.user?.login ?? 'unknown',
      head: pr.head.ref,
      base: pr.base.ref,
      draft: pr.draft,
      labels: (pr.labels ?? []).map((l) => l.name),
      created_at: pr.created_at,
    }))
  }

  /** Get detailed info about a single pull request. */
  async getPR(
    owner: string,
    repo: string,
    prNumber: number,
    host = 'github.com',
  ): Promise<
    | {
        number: number
        title: string
        state: string
        body: string
        html_url: string
        user: string
        head: string
        headSHA: string
        base: string
        draft: boolean
        mergeable: boolean | null
        changed_files: number
        additions: number
        deletions: number
        created_at: string
        updated_at: string
      }
    | undefined
  > {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const data = await this.apiGet<{
      number: number
      title: string
      state: string
      body: string | null
      html_url: string
      user: { login: string } | null
      head: { ref: string; sha: string }
      base: { ref: string }
      draft: boolean
      mergeable: boolean | null
      changed_files: number
      additions: number
      deletions: number
      created_at: string
      updated_at: string
    }>(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`, token, 'getPR')

    if (!data) return undefined
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      body: data.body ?? '',
      html_url: data.html_url,
      user: data.user?.login ?? 'unknown',
      head: data.head.ref,
      headSHA: data.head.sha,
      base: data.base.ref,
      draft: data.draft,
      mergeable: data.mergeable,
      changed_files: data.changed_files,
      additions: data.additions,
      deletions: data.deletions,
      created_at: data.created_at,
      updated_at: data.updated_at,
    }
  }

  /** Get files changed in a pull request (includes patch content). */
  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number,
    host = 'github.com',
  ): Promise<
    Array<{
      filename: string
      status: string
      additions: number
      deletions: number
      patch: string
    }>
  > {
    const token = await this.getToken(owner, repo)
    if (!token) return []

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const data = await this.apiGet<
      Array<{
        filename: string
        status: string
        additions: number
        deletions: number
        patch?: string
      }>
    >(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`, token, 'getPRFiles')

    if (!data) return []
    return data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? '',
    }))
  }

  /** Get the full unified diff of a pull request. */
  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
    host = 'github.com',
  ): Promise<string | undefined> {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    try {
      const response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3.diff',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (!response.ok) {
        log.error('GitHub API getPRDiff error', {
          status: response.status,
          body: (await response.text()).slice(0, 500),
        })
        return undefined
      }
      return await response.text()
    } catch (error) {
      log.error('GitHub API getPRDiff request failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * Submit a pull request review with optional line-level comments.
   * event: APPROVE | REQUEST_CHANGES | COMMENT
   */
  async createReview(
    owner: string,
    repo: string,
    prNumber: number,
    opts: {
      body: string
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
      comments?: Array<{ path: string; line: number; body: string }>
    },
    host = 'github.com',
  ): Promise<{ id: number } | undefined> {
    const token = await this.getToken(owner, repo)
    if (!token) return undefined

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    return this.apiPost<{ id: number }>(
      `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      token,
      {
        body: opts.body,
        event: opts.event,
        comments: opts.comments ?? [],
      },
      (data) => ({ id: data.id as number }),
      'createReview',
    )
  }

  /** List review comments on a pull request. */
  async listReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    host = 'github.com',
  ): Promise<Array<{ id: number; path: string; line: number | null; body: string; user: string }>> {
    const token = await this.getToken(owner, repo)
    if (!token) return []

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const data = await this.apiGet<
      Array<{
        id: number
        path: string
        line: number | null
        body: string
        user: { login: string } | null
      }>
    >(
      `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
      token,
      'listReviewComments',
    )

    if (!data) return []
    return data.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line,
      body: c.body,
      user: c.user?.login ?? 'unknown',
    }))
  }

  /**
   * Fetch full PR discussion context: issue-level comments + review summaries.
   * Complements `listReviewComments` (which only returns line-level review comments).
   * GitHub treats PRs as issues, so `/issues/{n}/comments` works for PR discussions.
   */
  async getPRConversation(
    owner: string,
    repo: string,
    prNumber: number,
    host = 'github.com',
  ): Promise<{
    issueComments: Array<{ user: string; body: string; createdAt: string }>
    reviewSummaries: Array<{
      user: string
      body: string
      state: string
      createdAt: string
    }>
  }> {
    const token = await this.getToken(owner, repo)
    if (!token) return { issueComments: [], reviewSummaries: [] }

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    const [rawComments, rawReviews] = await Promise.all([
      this.apiGet<
        Array<{ user: { login: string } | null; body: string | null; created_at: string }>
      >(
        `${apiBase}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
        token,
        'getPRIssueComments',
      ),
      this.apiGet<
        Array<{
          user: { login: string } | null
          body: string | null
          state: string
          submitted_at: string
        }>
      >(
        `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
        token,
        'getPRReviews',
      ),
    ])

    const issueComments = (rawComments ?? [])
      .filter((c) => c.body?.trim())
      .map((c) => ({
        user: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
      }))

    const reviewSummaries = (rawReviews ?? [])
      .filter((r) => r.body?.trim())
      .map((r) => ({
        user: r.user?.login ?? 'unknown',
        body: r.body ?? '',
        state: r.state ?? '',
        createdAt: r.submitted_at ?? '',
      }))

    return { issueComments, reviewSummaries }
  }

  /**
   * Check whether an issue has any linked open pull requests
   * by inspecting timeline cross-reference events.
   */
  async hasLinkedOpenPR(
    owner: string,
    repo: string,
    issueNumber: number,
    host = 'github.com',
  ): Promise<boolean> {
    const token = await this.getToken(owner, repo)
    if (!token) return false

    const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    const url = `${apiBase}/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`

    const events = await this.apiGet<
      Array<{
        event: string
        source?: {
          issue?: {
            number: number
            state: string
            pull_request?: unknown
          }
        }
      }>
    >(url, token, 'hasLinkedOpenPR')

    if (!events) return false

    return events.some(
      (e) =>
        e.event === 'cross-referenced' &&
        e.source?.issue?.pull_request &&
        e.source.issue.state === 'open',
    )
  }

  private async apiPatch(
    url: string,
    token: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errBody = await response.text()
        log.error(`GitHub API ${label} error`, {
          status: response.status,
          body: errBody.slice(0, 500),
        })
        return false
      }

      log.info(`GitHub API ${label} success`)
      return true
    } catch (error) {
      log.error(`GitHub API ${label} request failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  private async apiGet<T>(url: string, token: string, label: string): Promise<T | undefined> {
    this.lastStatus = 0
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })

      this.lastStatus = response.status
      if (!response.ok) {
        const errBody = await response.text()
        log.error(`GitHub API ${label} error`, {
          status: response.status,
          body: errBody.slice(0, 500),
        })
        return undefined
      }

      return (await response.json()) as T
    } catch (error) {
      log.error(`GitHub API ${label} request failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async apiPost<T>(
    url: string,
    token: string,
    body: Record<string, unknown>,
    transform: (data: Record<string, unknown>) => T,
    label: string,
  ): Promise<T | undefined> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errBody = await response.text()
        log.error(`GitHub API ${label} error`, {
          status: response.status,
          body: errBody.slice(0, 500),
        })
        return undefined
      }

      const data = (await response.json()) as Record<string, unknown>
      const result = transform(data)
      log.info(`GitHub API ${label} success`, { url: (result as any).url })
      return result
    } catch (error) {
      log.error(`GitHub API ${label} request failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton management                                               */
/* ------------------------------------------------------------------ */

let _client: GitHubClient | null = null

/**
 * Get the shared GitHubClient instance.
 * Initializes GitHub App auth if configured, otherwise uses PAT.
 */
export async function getGitHubClient(): Promise<GitHubClient> {
  if (_client) return _client

  const { loadGitHubAppConfig, GitHubAppAuth } = await import('./app-auth.js')
  const appConfig = loadGitHubAppConfig()
  const appAuth = appConfig ? new GitHubAppAuth(appConfig) : null

  if (appAuth) {
    log.info('GitHub Client initialized with App authentication')
  } else if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    log.info('GitHub Client initialized with PAT authentication')
  } else {
    log.info('GitHub Client initialized without authentication')
  }

  _client = new GitHubClient(appAuth)
  return _client
}

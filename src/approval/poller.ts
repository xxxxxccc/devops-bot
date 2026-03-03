/**
 * Approval Poller — periodically checks issues for approval reactions and
 * uses the Issue AI to synthesize actionable tasks.
 *
 * Two discovery paths:
 *   A. Bot-created issues (pending_approvals table) — check reactions on known issues
 *   B. External issues (repo scan) — list open issues with configured labels, check reactions
 *
 * When an approval reaction is found:
 *   1. Fetch full issue context (body + comments)
 *   2. Run Issue AI to synthesize a structured task
 *   3. If feasible → create task; if not → post comment explaining why
 *
 * Robustness:
 *   - Handles deleted issues (404/410) → marks expired
 *   - Prevents double-trigger via processed_issues table
 *   - Truncates very long contexts before passing to AI
 *   - Supports both GitHub and GitLab
 */

import { createLogger } from '../infra/logger.js'
import type { ApprovalStore, PendingApproval } from './store.js'
import type { GitHubClient } from '../github/client.js'
import type { IMPlatform } from '../channels/types.js'
import { type IssueContext, synthesizeTask } from './issue-ai.js'
import type { ProjectRegistry, ProjectRecord } from '../project/registry.js'

const log = createLogger('approval-poller')

const APPROVAL_REACTIONS = new Set(['+1', 'heart', 'hooray'])
const GITLAB_APPROVAL_NAMES = new Set(['thumbsup', 'heart'])

const ISSUE_SCAN_LABELS = process.env.ISSUE_SCAN_LABELS || 'devops-bot'

export interface ApprovalPollerDeps {
  approvalStore: ApprovalStore
  githubClient: GitHubClient
  imPlatform: IMPlatform | null
  getProjectRegistry: () => Promise<ProjectRegistry | null>
  createTask: (data: {
    title: string
    description: string
    createdBy: string
    projectPath?: string
    metadata?: Record<string, unknown>
  }) => Promise<string>
}

export class ApprovalPoller {
  deps: ApprovalPollerDeps
  private intervalMs: number
  private expiryDays: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: ApprovalPollerDeps, intervalMs = 1_800_000, expiryDays = 7) {
    this.deps = deps
    this.intervalMs = intervalMs
    this.expiryDays = expiryDays
  }

  start(): void {
    if (this.timer) return
    log.info(
      `Approval poller started (interval: ${this.intervalMs}ms, expiry: ${this.expiryDays}d)`,
    )
    this.timer = setInterval(
      () => this.poll().catch((err) => log.error('Poll cycle failed', { error: String(err) })),
      this.intervalMs,
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.info('Approval poller stopped')
    }
  }

  async poll(): Promise<void> {
    log.info('Poll cycle started')

    this.deps.approvalStore.cleanup(this.expiryDays)

    // Path A: bot-created issues from pending_approvals
    await this.pollPendingApprovals()

    // Path B: external issues from repo scanning
    await this.scanRepoIssues()

    log.info('Poll cycle completed')
  }

  /* ================================================================== */
  /*  Path A: Bot-created issues (pending_approvals)                     */
  /* ================================================================== */

  private async pollPendingApprovals(): Promise<void> {
    const pending = this.deps.approvalStore.getPending()
    if (pending.length === 0) return

    log.debug(`Checking ${pending.length} pending approval(s)`)

    for (const approval of pending) {
      try {
        await this.checkBotCreatedIssue(approval)
      } catch (err) {
        log.error('Error checking approval', {
          id: approval.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async checkBotCreatedIssue(approval: PendingApproval): Promise<void> {
    if (!approval.owner || !approval.repo || !approval.issueNumber) {
      log.warn('Approval record missing essential fields, skipping', { id: approval.id })
      return
    }

    const repoKey = `${approval.owner}/${approval.repo}`
    if (this.deps.approvalStore.isIssueProcessed(repoKey, approval.issueNumber)) {
      this.deps.approvalStore.markApproved(approval.id)
      return
    }

    if (approval.platform === 'github') {
      await this.checkGitHubApproval(approval)
    } else if (approval.platform === 'gitlab') {
      await this.checkGitLabApproval(approval)
    }
  }

  private async checkGitHubApproval(approval: PendingApproval): Promise<void> {
    const { githubClient } = this.deps
    const { owner, repo, issueNumber, host } = approval

    const reactions = await githubClient.listIssueReactions(owner, repo, issueNumber, host)
    const hasApproval = reactions.some((r) => APPROVAL_REACTIONS.has(r.content))
    if (!hasApproval) return

    const issueData = await githubClient.getIssueWithComments(owner, repo, issueNumber, host)
    if (!issueData) return

    if ('notFound' in issueData && issueData.notFound) {
      this.deps.approvalStore.markExpired(approval.id)
      return
    }

    if (!isOpenState(issueData.state)) {
      this.deps.approvalStore.markExpired(approval.id)
      return
    }

    if (await githubClient.hasLinkedOpenPR(owner, repo, issueNumber, host)) {
      log.info('Issue has linked open PR, skipping execution', {
        repo: `${owner}/${repo}`,
        issueNumber,
      })
      return
    }

    // Re-check status to prevent double-trigger
    const current = this.deps.approvalStore.getPending().find((a) => a.id === approval.id)
    if (!current || current.status !== 'pending') return

    this.deps.approvalStore.markApproved(approval.id)

    await this.processIssueWithAI(
      {
        title: issueData.body ? approval.taskTitle || `Issue #${issueNumber}` : approval.taskTitle,
        body: issueData.body,
        labels: approval.issueLabels ?? [],
        comments: issueData.comments,
        repoOwner: owner,
        repoName: repo,
        issueNumber,
        issueUrl: approval.issueUrl,
      },
      {
        projectPath: approval.projectPath,
        createdBy: approval.createdBy,
        source: 'bot' as const,
        imChatId: approval.imChatId,
        imMessageId: approval.imMessageId,
        platform: approval.platform,
        host,
      },
    )
  }

  private async checkGitLabApproval(approval: PendingApproval): Promise<void> {
    const { owner, repo, issueNumber, host } = approval
    const token =
      process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN || process.env.GL_TOKEN
    if (!token) return

    const apiBase = `https://${host}/api/v4`
    const projectId = encodeURIComponent(`${owner}/${repo}`)

    const emojis = await this.gitlabGet<Array<{ name: string }>>(
      `${apiBase}/projects/${projectId}/issues/${issueNumber}/award_emoji`,
      token,
    )
    if (!emojis) {
      if (this.lastGitlabStatus === 404) {
        this.deps.approvalStore.markExpired(approval.id)
      }
      return
    }

    const hasApproval = emojis.some((e) => GITLAB_APPROVAL_NAMES.has(e?.name))
    if (!hasApproval) return

    const issueDetail = await this.gitlabGet<{
      state: string
      title: string
      description: string | null
    }>(`${apiBase}/projects/${projectId}/issues/${issueNumber}`, token)
    if (!issueDetail || !isOpenState(issueDetail.state)) {
      if (issueDetail && !isOpenState(issueDetail.state)) {
        this.deps.approvalStore.markExpired(approval.id)
      }
      return
    }

    if (await this.gitlabIssueHasOpenMR(apiBase, projectId, issueNumber, token)) {
      log.info('GitLab issue has linked open MR, skipping execution', {
        repo: `${owner}/${repo}`,
        issueNumber,
      })
      return
    }

    const current = this.deps.approvalStore.getPending().find((a) => a.id === approval.id)
    if (!current || current.status !== 'pending') return

    this.deps.approvalStore.markApproved(approval.id)

    const notes =
      (await this.gitlabGet<
        Array<{ author: { username: string } | null; body: string | null; created_at: string }>
      >(`${apiBase}/projects/${projectId}/issues/${issueNumber}/notes?sort=asc`, token)) ?? []

    await this.processIssueWithAI(
      {
        title: issueDetail.title || approval.taskTitle,
        body: issueDetail.description ?? '',
        labels: approval.issueLabels ?? [],
        comments: notes
          .filter((n): n is typeof n & {} => n != null)
          .map((n) => ({
            user: n.author?.username ?? 'unknown',
            body: n.body ?? '',
            createdAt: n.created_at ?? '',
          })),
        repoOwner: owner,
        repoName: repo,
        issueNumber,
        issueUrl: approval.issueUrl,
      },
      {
        projectPath: approval.projectPath,
        createdBy: approval.createdBy,
        source: 'bot' as const,
        imChatId: approval.imChatId,
        imMessageId: approval.imMessageId,
        platform: approval.platform,
        host,
      },
    )
  }

  /* ================================================================== */
  /*  Path B: External issues (repo scanning)                            */
  /* ================================================================== */

  private async scanRepoIssues(): Promise<void> {
    const registry = await this.deps.getProjectRegistry()
    if (!registry) return

    const projects = registry.listAll()
    if (projects.length === 0) return

    for (const project of projects) {
      try {
        await this.scanProjectIssues(project)
      } catch (err) {
        log.error('Error scanning project issues', {
          projectId: project.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async scanProjectIssues(project: ProjectRecord): Promise<void> {
    const repoInfo = parseGitUrl(project.gitUrl)
    if (!repoInfo) return

    const { owner, repo, host, platform } = repoInfo

    if (platform === 'github') {
      await this.scanGitHubIssues(owner, repo, host, project)
    } else if (platform === 'gitlab') {
      await this.scanGitLabIssues(owner, repo, host, project)
    }
  }

  private async scanGitHubIssues(
    owner: string,
    repo: string,
    host: string,
    project: ProjectRecord,
  ): Promise<void> {
    const { githubClient, approvalStore } = this.deps
    const repoKey = `${owner}/${repo}`

    const issues = await githubClient.listOpenIssuesWithLabel(owner, repo, ISSUE_SCAN_LABELS, host)
    if (issues.length === 0) return

    for (const issue of issues) {
      if (approvalStore.isIssueProcessed(repoKey, issue.number)) continue

      const reactions = await githubClient.listIssueReactions(owner, repo, issue.number, host)
      const hasApproval = reactions.some((r) => APPROVAL_REACTIONS.has(r.content))
      if (!hasApproval) continue

      if (await githubClient.hasLinkedOpenPR(owner, repo, issue.number, host)) {
        log.info('External issue has linked open PR, skipping', {
          repo: repoKey,
          issueNumber: issue.number,
        })
        continue
      }

      log.info('Approved external issue found', {
        repo: repoKey,
        issueNumber: issue.number,
      })

      const issueData = await githubClient.getIssueWithComments(owner, repo, issue.number, host)
      if (!issueData || ('notFound' in issueData && issueData.notFound)) continue
      if (!isOpenState(issueData.state)) continue

      await this.processIssueWithAI(
        {
          title: issue.title,
          body: issueData.body,
          labels: issue.labels,
          comments: issueData.comments,
          repoOwner: owner,
          repoName: repo,
          issueNumber: issue.number,
          issueUrl: issue.html_url,
        },
        {
          projectPath: project.localPath,
          createdBy: 'github-issue',
          source: 'external' as const,
          platform: 'github',
          host,
        },
      )
    }
  }

  private async scanGitLabIssues(
    owner: string,
    repo: string,
    host: string,
    project: ProjectRecord,
  ): Promise<void> {
    const token =
      process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN || process.env.GL_TOKEN
    if (!token) return

    const apiBase = `https://${host}/api/v4`
    const projectId = encodeURIComponent(`${owner}/${repo}`)
    const repoKey = `${owner}/${repo}`

    const issues = await this.gitlabGet<
      Array<{
        iid: number
        title: string
        description: string | null
        web_url: string
        labels: string[]
      }>
    >(
      `${apiBase}/projects/${projectId}/issues?labels=${encodeURIComponent(ISSUE_SCAN_LABELS)}&state=opened&per_page=30`,
      token,
    )
    if (!issues || issues.length === 0) return

    for (const issue of issues) {
      if (this.deps.approvalStore.isIssueProcessed(repoKey, issue.iid)) continue

      const emojis = await this.gitlabGet<Array<{ name: string }>>(
        `${apiBase}/projects/${projectId}/issues/${issue.iid}/award_emoji`,
        token,
      )
      const hasApproval = emojis?.some((e) => GITLAB_APPROVAL_NAMES.has(e?.name))
      if (!hasApproval) continue

      if (await this.gitlabIssueHasOpenMR(apiBase, projectId, issue.iid, token)) {
        log.info('External GitLab issue has linked open MR, skipping', {
          repo: repoKey,
          issueIid: issue.iid,
        })
        continue
      }

      log.info('Approved external GitLab issue found', {
        repo: repoKey,
        issueIid: issue.iid,
      })

      const notes =
        (await this.gitlabGet<
          Array<{ author: { username: string } | null; body: string | null; created_at: string }>
        >(`${apiBase}/projects/${projectId}/issues/${issue.iid}/notes?sort=asc`, token)) ?? []

      await this.processIssueWithAI(
        {
          title: issue.title,
          body: issue.description ?? '',
          labels: issue.labels ?? [],
          comments: notes
            .filter((n): n is typeof n & {} => n != null)
            .map((n) => ({
              user: n.author?.username ?? 'unknown',
              body: n.body ?? '',
              createdAt: n.created_at ?? '',
            })),
          repoOwner: owner,
          repoName: repo,
          issueNumber: issue.iid,
          issueUrl: issue.web_url,
        },
        {
          projectPath: project.localPath,
          createdBy: 'gitlab-issue',
          source: 'external' as const,
          platform: 'gitlab',
          host,
        },
      )
    }
  }

  /* ================================================================== */
  /*  Issue AI processing (shared by both paths)                         */
  /* ================================================================== */

  private async processIssueWithAI(
    ctx: IssueContext,
    meta: {
      projectPath: string
      createdBy: string
      source: 'bot' | 'external'
      imChatId?: string | null
      imMessageId?: string | null
      platform: 'github' | 'gitlab'
      host: string
    },
  ): Promise<void> {
    const repoKey = `${ctx.repoOwner}/${ctx.repoName}`

    // Double-check not already processed
    if (this.deps.approvalStore.isIssueProcessed(repoKey, ctx.issueNumber)) return

    const synthesized = await synthesizeTask(ctx)

    if (!synthesized.feasible) {
      log.info('Issue AI deemed task not feasible', {
        issueNumber: ctx.issueNumber,
        reason: synthesized.reason,
      })

      await this.postIssueComment(
        meta.platform,
        ctx.repoOwner,
        ctx.repoName,
        ctx.issueNumber,
        meta.host,
        `**DevOps Bot:** This issue cannot be automatically executed.\n\n**Reason:** ${synthesized.reason || 'The requirements are not specific enough for automated execution.'}`,
      )

      this.deps.approvalStore.markIssueProcessed(repoKey, ctx.issueNumber, null, meta.source)
      return
    }

    try {
      const taskId = await this.deps.createTask({
        title: synthesized.title,
        description: synthesized.description,
        createdBy: meta.createdBy,
        projectPath: meta.projectPath,
        metadata: {
          issueUrl: ctx.issueUrl,
          issueNumber: ctx.issueNumber,
          issueSource: meta.source,
          issueRepoOwner: ctx.repoOwner,
          issueRepoName: ctx.repoName,
          issuePlatform: meta.platform,
          issueHost: meta.host,
          imChatId: meta.imChatId ?? undefined,
          imMessageId: meta.imMessageId ?? undefined,
          language: synthesized.language,
        },
      })

      this.deps.approvalStore.markIssueProcessed(repoKey, ctx.issueNumber, taskId, meta.source)

      log.info('Task created from issue via Issue AI', {
        taskId,
        issueUrl: ctx.issueUrl,
        source: meta.source,
      })

      await this.postIssueComment(
        meta.platform,
        ctx.repoOwner,
        ctx.repoName,
        ctx.issueNumber,
        meta.host,
        `**DevOps Bot:** Task execution started.\n\n**Task:** ${synthesized.title}`,
      )

      // IM notification for bot-created issues
      if (meta.source === 'bot' && meta.imChatId && this.deps.imPlatform) {
        await this.deps.imPlatform
          .sendText(
            meta.imChatId,
            `Approved! Task execution started for: ${synthesized.title}\n${ctx.issueUrl}`,
            meta.imMessageId ? { replyTo: meta.imMessageId } : undefined,
          )
          .catch((err) => log.warn('Failed to send IM notification', { error: String(err) }))
      }
    } catch (err) {
      log.error('Failed to create task from issue', {
        issueNumber: ctx.issueNumber,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /* ================================================================== */
  /*  Comment posting (GitHub / GitLab)                                  */
  /* ================================================================== */

  private async postIssueComment(
    platform: 'github' | 'gitlab',
    owner: string,
    repo: string,
    issueNumber: number,
    host: string,
    body: string,
  ): Promise<void> {
    try {
      if (platform === 'github') {
        await this.deps.githubClient.createIssueComment(owner, repo, issueNumber, body, host)
      } else if (platform === 'gitlab') {
        const token =
          process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN || process.env.GL_TOKEN
        if (token) {
          const apiBase = `https://${host}/api/v4`
          const projectId = encodeURIComponent(`${owner}/${repo}`)
          await fetch(`${apiBase}/projects/${projectId}/issues/${issueNumber}/notes`, {
            method: 'POST',
            headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          })
        }
      }
    } catch (err) {
      log.warn('Failed to post issue comment', {
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /* ================================================================== */
  /*  GitLab helpers                                                     */
  /* ================================================================== */

  private lastGitlabStatus = 0

  private async gitlabIssueHasOpenMR(
    apiBase: string,
    projectId: string,
    issueIid: number,
    token: string,
  ): Promise<boolean> {
    const mrs = await this.gitlabGet<Array<{ state: string }>>(
      `${apiBase}/projects/${projectId}/issues/${issueIid}/related_merge_requests`,
      token,
    )
    if (!mrs) {
      const closedBy = await this.gitlabGet<Array<{ state: string }>>(
        `${apiBase}/projects/${projectId}/issues/${issueIid}/closed_by`,
        token,
      )
      return closedBy?.some((mr) => mr.state === 'opened') ?? false
    }
    return mrs.some((mr) => mr.state === 'opened')
  }

  private async gitlabGet<T>(url: string, token: string): Promise<T | undefined> {
    this.lastGitlabStatus = 0
    try {
      const response = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': token },
      })
      this.lastGitlabStatus = response.status
      if (!response.ok) {
        log.error('GitLab API error', { status: response.status })
        return undefined
      }
      return (await response.json()) as T
    } catch (err) {
      log.error('GitLab API request failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }
}

/* ==================================================================== */
/*  Utility functions                                                    */
/* ==================================================================== */

function isOpenState(state: string | undefined | null): boolean {
  if (!state) return false
  const s = state.toLowerCase()
  return s === 'open' || s === 'opened'
}

function parseGitUrl(
  gitUrl: string,
): { platform: 'github' | 'gitlab'; host: string; owner: string; repo: string } | null {
  // SSH: git@host:owner/repo.git
  const sshMatch = gitUrl.match(/git@([^:]+):([^/]+)\/([^/.]+)/)
  if (sshMatch) return classifyHost(sshMatch[1], sshMatch[2], sshMatch[3])

  // HTTPS: https://host/owner/repo.git
  const httpsMatch = gitUrl.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/.]+)/)
  if (httpsMatch) return classifyHost(httpsMatch[1], httpsMatch[2], httpsMatch[3])

  return null
}

function classifyHost(
  rawHost: string,
  owner: string,
  repo: string,
): { platform: 'github' | 'gitlab'; host: string; owner: string; repo: string } | null {
  const host = rawHost.toLowerCase()
  if (host.includes('github')) return { platform: 'github', host, owner, repo }
  if (host.includes('gitlab')) return { platform: 'gitlab', host, owner, repo }
  return null
}

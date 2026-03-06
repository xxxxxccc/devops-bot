/**
 * Approval Poller — periodically checks issues for approval reactions and
 * uses the Issue AI to synthesize actionable tasks.
 *
 * Three discovery paths:
 *   A. Bot-created issues (pending_approvals table) — check reactions on known issues
 *   B. External issues (repo scan) — list open issues with configured labels, check reactions
 *   C. Workspace issues — scan issues on workspace repos, triage + distribute to sub-projects
 *
 * When an approval reaction is found:
 *   1. Fetch full issue context (body + comments)
 *   2. If workspace context available → two-phase triage (quality gate + repo routing)
 *   3. Otherwise → single-phase synthesis (legacy)
 *   4. Create task(s); cross-repo issues create sub-issues in target repos
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
import {
  type IssueContext,
  type WorkspaceContext,
  synthesizeTask,
  triageIssue,
  synthesizeTaskForTarget,
} from './issue-ai.js'
import type { ProjectRegistry, ProjectRecord } from '../project/registry.js'
import type { ProjectResolver } from '../project/resolver.js'

const log = createLogger('approval-poller')

const APPROVAL_REACTIONS = new Set(['+1', 'heart', 'hooray'])
const GITLAB_APPROVAL_NAMES = new Set(['thumbsup', 'heart'])

const ISSUE_SCAN_LABELS = process.env.ISSUE_SCAN_LABELS || 'devops-bot'

export interface ApprovalPollerDeps {
  approvalStore: ApprovalStore
  githubClient: GitHubClient
  imPlatform: IMPlatform | null
  getProjectRegistry: () => Promise<ProjectRegistry | null>
  getProjectResolver: () => Promise<ProjectResolver | null>
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

    // Run first poll immediately on startup
    this.poll().catch((err) => log.error('Initial approval poll failed', { error: String(err) }))
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

    // Sync workspace repos so manifest/context stay up-to-date
    await this.syncWorkspaces()

    // Path A: bot-created issues from pending_approvals
    await this.pollPendingApprovals()

    // Path B: external issues from repo scanning
    await this.scanRepoIssues()

    // Path C: workspace issues (scan workspace repos and distribute to sub-projects)
    await this.scanWorkspaceIssues()

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
      if (approvalStore.isIssueProcessed(repoKey, issue.number, issue.updated_at)) continue

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
          issueUpdatedAt: issue.updated_at,
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
  /*  Issue AI processing (shared by all paths)                          */
  /* ================================================================== */

  private async processIssueWithAI(
    ctx: IssueContext,
    meta: {
      projectPath?: string
      createdBy: string
      source: 'bot' | 'external' | 'workspace'
      imChatId?: string | null
      imMessageId?: string | null
      platform: 'github' | 'gitlab'
      host: string
      workspaceContext?: WorkspaceContext
      issueUpdatedAt?: string
    },
  ): Promise<void> {
    const repoKey = `${ctx.repoOwner}/${ctx.repoName}`

    if (this.deps.approvalStore.isIssueProcessed(repoKey, ctx.issueNumber, meta.issueUpdatedAt))
      return

    // Load workspace context if not already provided (for project issues)
    let wsContext = meta.workspaceContext
    if (!wsContext) {
      wsContext = await this.loadWorkspaceContextForProject(ctx.repoOwner, ctx.repoName)
    }

    if (wsContext) {
      await this.processWithTriage(ctx, meta, wsContext)
    } else {
      await this.processLegacy(ctx, meta)
    }
  }

  /** Legacy single-phase processing (no workspace context). */
  private async processLegacy(
    ctx: IssueContext,
    meta: {
      projectPath?: string
      createdBy: string
      source: 'bot' | 'external' | 'workspace'
      imChatId?: string | null
      imMessageId?: string | null
      platform: 'github' | 'gitlab'
      host: string
    },
  ): Promise<void> {
    const repoKey = `${ctx.repoOwner}/${ctx.repoName}`
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

      this.notifyIM(meta, synthesized.title, ctx.issueUrl)
    } catch (err) {
      log.error('Failed to create task from issue', {
        issueNumber: ctx.issueNumber,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Two-phase processing with triage (quality gate + cross-repo routing). */
  private async processWithTriage(
    ctx: IssueContext,
    meta: {
      projectPath?: string
      createdBy: string
      source: 'bot' | 'external' | 'workspace'
      imChatId?: string | null
      imMessageId?: string | null
      platform: 'github' | 'gitlab'
      host: string
      issueUpdatedAt?: string
    },
    wsContext: WorkspaceContext,
  ): Promise<void> {
    const repoKey = `${ctx.repoOwner}/${ctx.repoName}`

    const triage = await triageIssue(ctx, wsContext)

    if (triage.verdict === 'reject') {
      log.info('Triage rejected issue', {
        issueNumber: ctx.issueNumber,
        reason: triage.verdictReason.slice(0, 200),
      })
      await this.postIssueComment(
        meta.platform,
        ctx.repoOwner,
        ctx.repoName,
        ctx.issueNumber,
        meta.host,
        `**DevOps Bot — Triage:** This issue is not suitable for automated execution.\n\n${triage.verdictReason}`,
      )
      this.deps.approvalStore.markIssueProcessed(repoKey, ctx.issueNumber, null, meta.source)
      return
    }

    if (triage.verdict === 'needs_info') {
      log.info('Triage needs more info', {
        issueNumber: ctx.issueNumber,
        reason: triage.verdictReason.slice(0, 200),
      })
      const commentCreatedAt = await this.postIssueComment(
        meta.platform,
        ctx.repoOwner,
        ctx.repoName,
        ctx.issueNumber,
        meta.host,
        `**DevOps Bot — Triage:** More information is needed before this issue can be processed.\n\n${triage.verdictReason}`,
      )
      const watermark = commentCreatedAt || new Date().toISOString()
      this.deps.approvalStore.markIssueNeedsInfo(repoKey, ctx.issueNumber, watermark, meta.source)
      return
    }

    if (triage.targets.length === 0) {
      log.warn('Triage returned actionable but no targets', {
        issueNumber: ctx.issueNumber,
      })
      // Fall back to legacy if we have a project path
      if (meta.projectPath) {
        await this.processLegacy(ctx, meta)
      } else {
        await this.postIssueComment(
          meta.platform,
          ctx.repoOwner,
          ctx.repoName,
          ctx.issueNumber,
          meta.host,
          '**DevOps Bot — Triage:** Could not determine which project should handle this issue.',
        )
        this.deps.approvalStore.markIssueProcessed(repoKey, ctx.issueNumber, null, meta.source)
      }
      return
    }

    const resolver = await this.deps.getProjectResolver()
    const summaryParts: string[] = []
    const taskIds: string[] = []

    for (const target of triage.targets) {
      const synthesized = await synthesizeTaskForTarget(ctx, target, wsContext)

      if (!synthesized.feasible) {
        log.info('Target synthesis not feasible', {
          issueNumber: ctx.issueNumber,
          targetProject: target.projectId,
          reason: synthesized.reason,
        })
        summaryParts.push(
          `- **${target.projectId}**: Not feasible — ${synthesized.reason || 'insufficient context'}`,
        )
        continue
      }

      const targetRepoInfo = parseGitUrl(target.gitUrl)
      const isSameRepo =
        targetRepoInfo &&
        targetRepoInfo.owner === ctx.repoOwner &&
        targetRepoInfo.repo === ctx.repoName
      const isFromWorkspace = meta.source === 'workspace'

      let subIssueUrl: string | undefined
      if ((!isSameRepo || isFromWorkspace) && targetRepoInfo && meta.platform === 'github') {
        const subIssue = await this.deps.githubClient.createIssue(
          targetRepoInfo.owner,
          targetRepoInfo.repo,
          {
            title: synthesized.title,
            body: `${synthesized.description}\n\n---\n*Parent issue: ${ctx.issueUrl}*`,
            labels: [ISSUE_SCAN_LABELS],
          },
          targetRepoInfo.host,
        )
        if (subIssue) {
          subIssueUrl = subIssue.url
          log.info('Sub-issue created in target repo', {
            targetRepo: `${targetRepoInfo.owner}/${targetRepoInfo.repo}`,
            subIssueNumber: subIssue.number,
          })
        }
      }

      let projectPath = meta.projectPath
      if (resolver && (!isSameRepo || isFromWorkspace)) {
        const resolved = await resolver.resolveFromWorkspace(target.gitUrl, '')
        if (resolved) projectPath = resolved
      }

      if (!projectPath) {
        log.error('Cannot resolve project path for target', {
          targetProject: target.projectId,
        })
        summaryParts.push(`- **${target.projectId}**: Failed to resolve project path`)
        continue
      }

      try {
        const taskId = await this.deps.createTask({
          title: synthesized.title,
          description: synthesized.description,
          createdBy: meta.createdBy,
          projectPath,
          metadata: {
            issueUrl: subIssueUrl || ctx.issueUrl,
            issueNumber: ctx.issueNumber,
            issueSource: meta.source,
            issueRepoOwner: ctx.repoOwner,
            issueRepoName: ctx.repoName,
            issuePlatform: meta.platform,
            issueHost: meta.host,
            targetProjectId: target.projectId,
            targetGitUrl: target.gitUrl,
            subIssueUrl,
            imChatId: meta.imChatId ?? undefined,
            imMessageId: meta.imMessageId ?? undefined,
            language: triage.language ?? synthesized.language,
          },
        })

        taskIds.push(taskId)
        log.info('Task created for triage target', {
          taskId,
          targetProject: target.projectId,
          issueUrl: ctx.issueUrl,
        })

        if (subIssueUrl) {
          summaryParts.push(`- **${target.projectId}**: ${synthesized.title} → ${subIssueUrl}`)
        } else {
          summaryParts.push(`- **${target.projectId}**: ${synthesized.title}`)
        }
      } catch (err) {
        log.error('Failed to create task for triage target', {
          targetProject: target.projectId,
          error: err instanceof Error ? err.message : String(err),
        })
        summaryParts.push(`- **${target.projectId}**: Task creation failed`)
      }
    }

    this.deps.approvalStore.markIssueProcessed(
      repoKey,
      ctx.issueNumber,
      taskIds[0] ?? null,
      meta.source,
    )

    if (summaryParts.length > 0) {
      const header =
        triage.targets.length === 1 && summaryParts.length === 1
          ? '**DevOps Bot — Triage:** Task execution started.\n\n'
          : `**DevOps Bot — Triage:** Split into ${triage.targets.length} target(s).\n\n`
      await this.postIssueComment(
        meta.platform,
        ctx.repoOwner,
        ctx.repoName,
        ctx.issueNumber,
        meta.host,
        header + summaryParts.join('\n'),
      )
    }

    this.notifyIM(meta, triage.targets.map((t) => t.projectId).join(', '), ctx.issueUrl)
  }

  /** Try to load workspace context for a project based on its workspaceId. */
  private async loadWorkspaceContextForProject(
    repoOwner: string,
    repoName: string,
  ): Promise<WorkspaceContext | undefined> {
    try {
      const resolver = await this.deps.getProjectResolver()
      if (!resolver) return undefined

      const registry = resolver.getRegistry()
      const allProjects = registry.listAll()
      const project = allProjects.find((p) => p.gitUrl.includes(`${repoOwner}/${repoName}`))

      if (!project?.workspaceId) return undefined

      const wsInfo = resolver.getWorkspaceInfo(project.workspaceId)
      if (!wsInfo) return undefined

      return {
        projects: wsInfo.manifest.projects.map((p) => ({
          id: p.id,
          gitUrl: p.gitUrl,
          lang: p.lang,
          description: p.description,
        })),
        architectureDoc: wsInfo.context,
      }
    } catch {
      return undefined
    }
  }

  /** Send IM notification for bot-created issues. */
  private notifyIM(
    meta: {
      source: string
      imChatId?: string | null
      imMessageId?: string | null
    },
    title: string,
    issueUrl: string,
  ): void {
    if (meta.source === 'bot' && meta.imChatId && this.deps.imPlatform) {
      this.deps.imPlatform
        .sendText(
          meta.imChatId,
          `Approved! Task execution started for: ${title}\n${issueUrl}`,
          meta.imMessageId ? { replyTo: meta.imMessageId } : undefined,
        )
        .catch((err) => log.warn('Failed to send IM notification', { error: String(err) }))
    }
  }

  /* ================================================================== */
  /*  Path C: Workspace issues (scan workspace repos)                    */
  /* ================================================================== */

  private async syncWorkspaces(): Promise<void> {
    try {
      const resolver = await this.deps.getProjectResolver()
      if (!resolver) return

      const allWs = resolver.getAllWorkspaceInfos()
      for (const ws of allWs) {
        try {
          await resolver.syncWorkspace(ws.record.id)
          log.debug('Workspace synced', { id: ws.record.id })
        } catch (err) {
          log.warn('Workspace sync failed', {
            id: ws.record.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log.warn('Workspace sync skipped', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async scanWorkspaceIssues(): Promise<void> {
    const resolver = await this.deps.getProjectResolver()
    if (!resolver) return

    const workspaces = resolver.getAllWorkspaceInfos()
    if (workspaces.length === 0) return

    for (const wsInfo of workspaces) {
      try {
        await this.scanWorkspaceRepoIssues(wsInfo)
      } catch (err) {
        log.error('Error scanning workspace issues', {
          workspaceId: wsInfo.record.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async scanWorkspaceRepoIssues(
    wsInfo: import('../project/resolver.js').WorkspaceInfo,
  ): Promise<void> {
    const repoInfo = parseGitUrl(wsInfo.record.gitUrl)
    if (!repoInfo || repoInfo.platform !== 'github') return

    const { owner, repo, host } = repoInfo
    const { githubClient, approvalStore } = this.deps
    const repoKey = `${owner}/${repo}`

    const issues = await githubClient.listOpenIssuesWithLabel(owner, repo, ISSUE_SCAN_LABELS, host)
    if (issues.length === 0) return

    const wsContext: WorkspaceContext = {
      projects: wsInfo.manifest.projects.map((p) => ({
        id: p.id,
        gitUrl: p.gitUrl,
        lang: p.lang,
        description: p.description,
      })),
      architectureDoc: wsInfo.context,
    }

    for (const issue of issues) {
      if (approvalStore.isIssueProcessed(repoKey, issue.number, issue.updated_at)) continue

      const reactions = await githubClient.listIssueReactions(owner, repo, issue.number, host)
      const hasApproval = reactions.some((r) => APPROVAL_REACTIONS.has(r.content))
      if (!hasApproval) continue

      log.info('Approved workspace issue found', {
        workspace: wsInfo.record.id,
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
          createdBy: 'workspace-issue',
          source: 'workspace' as const,
          platform: 'github',
          host,
          workspaceContext: wsContext,
          issueUpdatedAt: issue.updated_at,
        },
      )
    }
  }

  /* ================================================================== */
  /*  Comment posting (GitHub / GitLab)                                  */
  /* ================================================================== */

  /** Posts a comment and returns the comment's created_at timestamp (GitHub only). */
  private async postIssueComment(
    platform: 'github' | 'gitlab',
    owner: string,
    repo: string,
    issueNumber: number,
    host: string,
    body: string,
  ): Promise<string | undefined> {
    try {
      if (platform === 'github') {
        return await this.deps.githubClient.createIssueComment(owner, repo, issueNumber, body, host)
      }
      if (platform === 'gitlab') {
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
    return undefined
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

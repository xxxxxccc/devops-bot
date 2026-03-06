/**
 * Task Runner — queue management, AI execution, lifecycle callbacks.
 *
 * Concurrency model:
 *   - Per-project serial: tasks targeting the same project run one at a time
 *   - Cross-project parallel: tasks for different projects run concurrently
 *   - Global limit: MAX_CONCURRENT_TASKS (default 3)
 *
 * Orchestrates:
 * - AI execution via AIExecutor
 * - MCP config generation
 * - SSE event broadcasting
 * - IM platform notifications (card updates)
 * - Memory feedback (task_input / task_result / task_failure)
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { Task, WebhookConfig } from '../core/types.js'
import type { GitHubClient } from '../github/client.js'
import { TaskStore } from '../core/task-store.js'
import { createLogger } from '../infra/logger.js'
import { getMemoryStore } from '../memory/store.js'
import { MemoryExtractor } from '../memory/extractor.js'
import { MemoryRetriever } from '../memory/retriever.js'
import { ProjectScanner } from '../prompt/project-scanner.js'
import { SkillScanner } from '../prompt/skill-scanner.js'
import { type Sandbox, SandboxManager } from '../sandbox/manager.js'
import { ReviewEngine } from '../review/engine.js'
import type { SSEManager } from './sse.js'
import {
  buildExecutorSystemPrompt,
  buildPRModifyPrompt,
  buildReviewFixPrompt,
  detectJiraLinks,
  detectFigmaLinks,
} from './prompt.js'
import { detectRepo } from '../sandbox/pr-creator.js'

const log = createLogger('task-runner')

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_PATH = join(__dirname, '..', '..', 'dist', 'mcp', 'server.js')

const DEFAULT_WORKSPACE_DIR = join(homedir(), '.devops-bot')

interface QueueItem {
  taskId: string
  prompt: string
  metadata?: Record<string, unknown>
  projectPath: string
}

export class TaskRunner {
  readonly store: TaskStore
  private sse: SSEManager

  // Queue state — per-project serial, cross-project parallel
  private taskQueue: QueueItem[] = []
  private runningTasks = new Map<string, string>() // taskId -> projectPath
  private readonly maxConcurrency: number

  // Running process handles (for stop support)
  private runningProcesses: Map<string, ChildProcess> = new Map()
  private runningAbortControllers: Map<string, AbortController> = new Map()

  // IM platform reference for task notifications
  private imPlatform: import('../channels/types.js').IMPlatform | null = null
  // GitHub client for posting issue comments on completion/failure
  private githubClient: GitHubClient | null = null
  // Memory extractor (lazy init)
  private memoryExtractor: MemoryExtractor | null = null
  // Project scanner for reading project rules
  private readonly projectScanner = new ProjectScanner()
  // Skill scanner for bundled skills
  private readonly skillScanner = new SkillScanner()
  // Sandbox manager for worktree-based task isolation
  private readonly sandboxManager = new SandboxManager()

  private config: WebhookConfig

  constructor(config: WebhookConfig, sse: SSEManager) {
    this.config = config
    this.store = new TaskStore()
    this.sse = sse
    this.maxConcurrency = config.maxConcurrentTasks || 3
  }

  async init(): Promise<void> {
    await this.store.init()
  }

  get queueLength(): number {
    return this.taskQueue.length
  }

  get isProcessing(): boolean {
    return this.runningTasks.size > 0
  }

  get runningCount(): number {
    return this.runningTasks.size
  }

  setIMPlatform(platform: import('../channels/types.js').IMPlatform): void {
    this.imPlatform = platform
  }

  setGitHubClient(client: GitHubClient): void {
    this.githubClient = client
  }

  /* ---------------------------------------------------------------- */
  /*  Public: enqueue a task                                           */
  /* ---------------------------------------------------------------- */

  async runTask(
    taskId: string,
    prompt: string,
    metadata?: Record<string, unknown>,
    createdBy?: string,
    projectPath?: string,
  ): Promise<void> {
    const effectivePath = projectPath || this.config.projectPath || ''

    const task: Task = {
      id: taskId,
      status: 'pending',
      prompt,
      output: '',
      createdAt: new Date().toISOString(),
      createdBy,
      metadata,
    }
    this.store.set(task)

    this.sse.broadcastTaskEvent({
      type: 'task_created',
      task,
      timestamp: new Date().toISOString(),
    })

    this.taskQueue.push({ taskId, prompt, metadata, projectPath: effectivePath })
    log.info(`Task ${taskId} queued`, {
      position: this.taskQueue.length,
      project: effectivePath,
    })

    this.processQueue()
  }

  /* ---------------------------------------------------------------- */
  /*  Public: stop a running task                                      */
  /* ---------------------------------------------------------------- */

  stopTask(taskId: string): boolean {
    const childProcess = this.runningProcesses.get(taskId)
    if (childProcess) {
      childProcess.kill('SIGTERM')
      setTimeout(() => {
        if (!childProcess.killed) {
          log.warn(`Task ${taskId} force killing`)
          childProcess.kill('SIGKILL')
        }
      }, 5000)
      this.runningProcesses.delete(taskId)
    }

    const abortController = this.runningAbortControllers.get(taskId)
    if (abortController) {
      abortController.abort()
      this.runningAbortControllers.delete(taskId)
    }

    const updatedTask = this.store.update(taskId, {
      status: 'failed',
      error: 'Task stopped by user',
    })

    if (updatedTask) {
      this.sse.broadcastTaskEvent({
        type: 'task_failed',
        task: updatedTask,
        timestamp: new Date().toISOString(),
      })
    }

    this.runningTasks.delete(taskId)
    this.processQueue()

    return !!(childProcess || abortController)
  }

  /* ---------------------------------------------------------------- */
  /*  Queue processing — per-project serial, cross-project parallel    */
  /* ---------------------------------------------------------------- */

  private isProjectBusy(projectPath: string): boolean {
    for (const path of this.runningTasks.values()) {
      if (path === projectPath) return true
    }
    return false
  }

  private processQueue(): void {
    while (this.runningTasks.size < this.maxConcurrency && this.taskQueue.length > 0) {
      const idx = this.taskQueue.findIndex((item) => !this.isProjectBusy(item.projectPath))
      if (idx === -1) break

      const item = this.taskQueue.splice(idx, 1)[0]
      this.runningTasks.set(item.taskId, item.projectPath)

      this.executeOneTask(item).finally(() => {
        this.runningTasks.delete(item.taskId)
        this.processQueue()
      })
    }
  }

  private async executeOneTask(item: QueueItem): Promise<void> {
    const { taskId, metadata, projectPath } = item
    let { prompt } = item

    const runningTask = this.store.update(taskId, { status: 'running' })
    if (runningTask) {
      this.sse.broadcastTaskEvent({
        type: 'task_updated',
        task: runningTask,
        timestamp: new Date().toISOString(),
      })
    }

    log.info(`Task ${taskId} starting`, {
      queueRemaining: this.taskQueue.length,
      running: this.runningTasks.size,
      project: projectPath,
    })

    let sandbox: Sandbox | undefined
    let mcpConfigPath: string | undefined
    const prNumber = metadata?.prNumber as number | undefined

    try {
      const taskTitle = (metadata?.title as string) || taskId

      if (prNumber && this.githubClient) {
        // PR modification mode: checkout existing PR branch
        const prContext = await this.preparePRModifyContext(prNumber, projectPath)
        if (!prContext) {
          throw new Error(
            `Cannot prepare context for PR #${prNumber} — PR may be closed or project has no git remote`,
          )
        }
        sandbox = await this.sandboxManager.createSandboxOnBranch(
          taskId,
          prContext.prBranch,
          projectPath,
        )

        prompt = buildPRModifyPrompt({
          taskId,
          title: taskTitle,
          description: metadata?.description as string,
          prNumber,
          owner: prContext.owner,
          repo: prContext.repo,
          prBranch: prContext.prBranch,
          diff: prContext.diff,
          discussion: prContext.discussion,
          reviewComments: prContext.reviewComments,
          language: metadata?.language as string | undefined,
        })
      } else {
        sandbox = await this.sandboxManager.createSandbox(taskId, taskTitle, projectPath)
      }

      mcpConfigPath = await this.createMCPConfig(sandbox.worktreePath)
      const task = this.store.get(taskId)
      const output = await this.executeAI(prompt, mcpConfigPath, task!, sandbox, projectPath)

      const { prUrl } = await this.sandboxManager.finalizeSandbox(
        sandbox,
        taskTitle,
        (task?.metadata?.description as string) || task?.summary?.thinking,
        task?.createdBy,
        task?.metadata?.issueNumber as number | undefined,
      )

      const updatedTask = this.store.update(taskId, {
        status: 'completed',
        output,
        prUrl: prUrl ?? undefined,
      })

      if (updatedTask) {
        this.sse.broadcastTaskEvent({
          type: 'task_completed',
          task: updatedTask,
          timestamp: new Date().toISOString(),
        })
        await this.memorizeTaskLifecycle(updatedTask, projectPath)
        await this.recordCompletionInChat(updatedTask, projectPath)
        await this.notifyCompletion(updatedTask)
        await this.notifyIssueResult(updatedTask)

        // For PR modifications, construct the prUrl for self-review
        const effectivePrUrl =
          prUrl || (prNumber ? await this.buildPRUrlFromMetadata(prNumber, projectPath) : undefined)
        if (effectivePrUrl) {
          void this.triggerSelfReview(updatedTask, effectivePrUrl, projectPath)
        }
      }

      log.info(`Task ${taskId} completed`, { prUrl })
    } catch (error) {
      const failedTask = this.store.update(taskId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })

      if (failedTask) {
        this.sse.broadcastTaskEvent({
          type: 'task_failed',
          task: failedTask,
          timestamp: new Date().toISOString(),
        })
        await this.memorizeTaskFailure(failedTask, projectPath)
        await this.recordCompletionInChat(failedTask, projectPath)
        await this.notifyFailure(failedTask)
        await this.notifyIssueResult(failedTask)
      }

      log.error(`Task ${taskId} failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (sandbox) {
        await this.sandboxManager.cleanupSandbox(sandbox).catch((e) =>
          log.warn('Sandbox cleanup failed', {
            taskId,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      }
      if (mcpConfigPath) {
        await unlink(mcpConfigPath).catch(() => {
          log.warn('Failed to delete MCP config file', { taskId, mcpConfigPath })
        })
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  AI execution                                                     */
  /* ---------------------------------------------------------------- */

  private async executeAI(
    prompt: string,
    mcpConfigPath: string,
    task: Task,
    sandbox: Sandbox | undefined,
    projectPath: string,
  ): Promise<string> {
    const { AIExecutor } = await import('../agent/ai-executor.js')
    const { createProviderFromEnv } = await import('../providers/index.js')

    const provider = await createProviderFromEnv()

    const devopsRoot = join(__dirname, '..', '..')
    const workspaceDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR
    const projectRules = projectPath ? this.projectScanner.getProjectRules(projectPath) : ''
    const skills = this.skillScanner.getSkills(devopsRoot, workspaceDir)
    const jiraEnabled = !!(process.env.JIRA_URL && process.env.JIRA_API_TOKEN)
    const figmaEnabled = !!process.env.FIGMA_API_KEY
    const systemPrompt = buildExecutorSystemPrompt({
      projectRules,
      taskHasJira: jiraEnabled && detectJiraLinks(prompt),
      taskHasFigma: figmaEnabled && detectFigmaLinks(prompt),
      skills,
      sandbox: sandbox
        ? {
            branchName: sandbox.branchName,
            baseBranch: sandbox.baseBranch,
            submodules: sandbox.submodules,
          }
        : undefined,
      language: (task.metadata?.language as string) || undefined,
    })
    let output = ''
    let lastBroadcast = 0
    const broadcastThrottleMs = 1000

    const executor = new AIExecutor({
      provider,
      model: process.env.TASK_MODEL || 'claude-opus-4-5-20251101',
      maxTokens: 16384,
      maxIterations: 100,
      systemPrompt,
      onOutput: (chunk: string) => {
        output += chunk
        const updatedTask = this.store.update(task.id, { output })
        process.stdout.write(chunk)

        const now = Date.now()
        if (updatedTask && now - lastBroadcast >= broadcastThrottleMs) {
          lastBroadcast = now
          this.sse.broadcastTaskOutput(updatedTask)
        }
      },
    })

    const abortController = new AbortController()
    this.runningAbortControllers.set(task.id, abortController)

    try {
      log.info(`Task ${task.id} connecting to MCP servers`)
      await executor.connectMCPServers(mcpConfigPath)

      log.info(`Task ${task.id} executing AI`)
      return await executor.execute(prompt)
    } finally {
      this.runningAbortControllers.delete(task.id)
      await executor.disconnect()
    }
  }

  /* ---------------------------------------------------------------- */
  /*  MCP config generation                                            */
  /* ---------------------------------------------------------------- */

  private async createMCPConfig(targetProjectPath?: string): Promise<string> {
    const devopsRoot = join(__dirname, '..', '..')
    const devopsApiUrl = `http://localhost:${this.config.port}`
    const effectivePath = targetProjectPath || this.config.projectPath || ''

    const mcpServers: Record<string, unknown> = {
      devopsBot: {
        command: 'node',
        args: [MCP_SERVER_PATH],
        env: {
          TARGET_PROJECT_PATH: effectivePath,
          DEVOPS_ROOT_PATH: devopsRoot,
          DEVOPS_API_URL: devopsApiUrl,
        },
      },
    }

    if (process.env.JIRA_URL && process.env.JIRA_API_TOKEN) {
      mcpServers.atlassian = {
        command: 'uvx',
        args: ['mcp-atlassian'],
        env: {
          JIRA_URL: process.env.JIRA_URL,
          JIRA_USERNAME: process.env.JIRA_USERNAME || '',
          JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
          CONFLUENCE_URL: process.env.CONFLUENCE_URL || '',
          CONFLUENCE_USERNAME: process.env.CONFLUENCE_USERNAME || '',
          CONFLUENCE_API_TOKEN: process.env.CONFLUENCE_API_TOKEN || '',
        },
      }
    }

    if (process.env.FIGMA_API_KEY) {
      mcpServers.figma = {
        command: 'npx',
        args: ['-y', 'figma-developer-mcp', '--stdio'],
        env: {
          FIGMA_API_KEY: process.env.FIGMA_API_KEY,
        },
      }
    }

    const config = { mcpServers }
    const configPath = `/tmp/devops-bot-mcp-${randomUUID()}.json`
    await writeFile(configPath, JSON.stringify(config, null, 2))
    return configPath
  }

  /* ---------------------------------------------------------------- */
  /*  Self-review + auto-fix loop                                      */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /*  PR modification helpers                                          */
  /* ---------------------------------------------------------------- */

  private async preparePRModifyContext(
    prNumber: number,
    projectPath: string,
  ): Promise<
    | {
        owner: string
        repo: string
        host: string
        prBranch: string
        diff: string
        discussion?: import('../review/prompt.js').PRDiscussionContext
        reviewComments?: Array<{ path: string; line: number | null; body: string; user: string }>
      }
    | undefined
  > {
    if (!this.githubClient) return undefined

    const repoInfo = await detectRepo(projectPath)
    if (!repoInfo.owner || !repoInfo.repo) return undefined

    const host = repoInfo.host || 'github.com'
    const pr = await this.githubClient.getPR(repoInfo.owner, repoInfo.repo, prNumber, host)
    if (!pr || pr.state !== 'open') {
      log.warn('PR is not open for modification', { prNumber, state: pr?.state })
      return undefined
    }

    const [diff, discussion, reviewComments] = await Promise.all([
      this.githubClient.getPRDiff(repoInfo.owner, repoInfo.repo, prNumber, host),
      this.githubClient.getPRConversation(repoInfo.owner, repoInfo.repo, prNumber, host),
      this.githubClient.listReviewComments(repoInfo.owner, repoInfo.repo, prNumber, host),
    ])

    return {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      host,
      prBranch: pr.head,
      diff: diff || '',
      discussion,
      reviewComments,
    }
  }

  private async buildPRUrlFromMetadata(
    prNumber: number,
    projectPath: string,
  ): Promise<string | undefined> {
    const repoInfo = await detectRepo(projectPath)
    if (!repoInfo.owner || !repoInfo.repo) return undefined
    const host = repoInfo.host || 'github.com'
    return `https://${host}/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`
  }

  /* ---------------------------------------------------------------- */
  /*  Self-review + auto-fix loop                                      */
  /* ---------------------------------------------------------------- */

  private static readonly MAX_FIX_ROUNDS = 2

  private async triggerSelfReview(task: Task, prUrl: string, projectPath: string): Promise<void> {
    if (process.env.ENABLE_SELF_REVIEW !== 'true') return
    if (!this.githubClient) return

    const parsed = parsePRUrl(prUrl)
    if (!parsed) {
      log.warn('Could not parse PR URL for self-review', { prUrl })
      return
    }

    await this.selfReviewAndFix(task, parsed, projectPath, prUrl, 0)
  }

  /**
   * Recursive self-review + auto-fix loop.
   *
   * Flow per round:
   *   1. Run review → get verdict + comments
   *   2. If approve / comment-only / max rounds reached → stop
   *   3. Otherwise: build fix prompt, create sandbox on PR branch, run AI fix, push, re-review
   */
  private async selfReviewAndFix(
    task: Task,
    prInfo: { owner: string; repo: string; prNumber: number; host: string },
    projectPath: string,
    prUrl: string,
    round: number,
  ): Promise<void> {
    const { owner, repo, prNumber, host } = prInfo
    const gh = this.githubClient!

    try {
      const store = await getMemoryStore()
      const engine = new ReviewEngine({
        githubClient: gh,
        memoryStore: store,
        memoryRetriever: new MemoryRetriever(store),
      })

      const result = await engine.reviewPR({
        owner,
        repo,
        prNumber,
        host,
        projectPath,
        imChatId: task.metadata?.imChatId as string | undefined,
        trigger: 'self-review',
        language: (task.metadata?.language as string) || undefined,
      })

      log.info('Self-review completed', {
        prNumber,
        verdict: result.overallVerdict,
        comments: result.stats.totalComments,
        round,
      })

      // Notify IM on every review round
      if (result.stats.totalComments > 0 && task.metadata?.imChatId && this.imPlatform) {
        const { buildIMCardBody } = await import('../review/comment-builder.js')
        const cardBody = buildIMCardBody(result, prUrl)
        await this.imPlatform.sendCard(task.metadata.imChatId as string, {
          markdown: cardBody,
          header: {
            title: round === 0 ? '🔍 Self-Review Complete' : `🔧 Re-Review (round ${round})`,
            color: 'blue',
          },
        })
      }

      // Decide whether to auto-fix
      const fixableCount = result.stats.critical + result.stats.warnings
      if (
        result.overallVerdict !== 'request_changes' ||
        fixableCount === 0 ||
        round >= TaskRunner.MAX_FIX_ROUNDS
      ) {
        if (round >= TaskRunner.MAX_FIX_ROUNDS && fixableCount > 0) {
          log.info('Max auto-fix rounds reached, stopping', { round, fixableCount })
        }
        return
      }

      // --- Auto-fix ---
      log.info('Starting auto-fix', { prNumber, round: round + 1, fixableCount })

      // Verify PR is still open before attempting fix
      const currentPR = await gh.getPR(owner, repo, prNumber, host)
      if (!currentPR || currentPR.state !== 'open') {
        log.info('PR no longer open, skipping auto-fix', { prNumber, state: currentPR?.state })
        return
      }

      const prBranch = result.prBranch || currentPR.head
      if (!prBranch) {
        log.warn('Cannot determine PR branch for auto-fix', { prNumber })
        return
      }

      // Fetch PR discussion for fix context
      const discussion = await gh.getPRConversation(owner, repo, prNumber, host)

      const fixTaskId = `${task.id}-fix-${round + 1}`
      const fixPrompt = buildReviewFixPrompt({
        taskId: fixTaskId,
        review: result,
        round: round + 1,
        discussion,
      })

      let sandbox: Sandbox | undefined
      let mcpConfigPath: string | undefined

      try {
        sandbox = await this.sandboxManager.createSandboxOnBranch(fixTaskId, prBranch, projectPath)
        mcpConfigPath = await this.createMCPConfig(sandbox.worktreePath)

        // Create a minimal task record for the fix
        const fixTask: Task = {
          id: fixTaskId,
          status: 'running',
          prompt: fixPrompt,
          output: '',
          createdAt: new Date().toISOString(),
          createdBy: 'self-review-fix',
          metadata: { ...task.metadata, title: `Fix review feedback (round ${round + 1})` },
        }
        this.store.set(fixTask)

        await this.executeAI(fixPrompt, mcpConfigPath, fixTask, sandbox, projectPath)

        // Push the fixes (no PR creation — PR already exists)
        await this.sandboxManager.finalizeSandbox(
          sandbox,
          `Fix review feedback (round ${round + 1})`,
        )

        this.store.update(fixTaskId, { status: 'completed' })
        log.info('Auto-fix push complete', { prNumber, round: round + 1 })
      } catch (fixErr) {
        log.error('Auto-fix failed', {
          prNumber,
          round: round + 1,
          error: fixErr instanceof Error ? fixErr.message : String(fixErr),
        })
        this.store.update(fixTaskId, {
          status: 'failed',
          error: fixErr instanceof Error ? fixErr.message : String(fixErr),
        })
        return
      } finally {
        if (sandbox) {
          await this.sandboxManager.cleanupSandbox(sandbox).catch((e) =>
            log.warn('Fix sandbox cleanup failed', {
              error: e instanceof Error ? e.message : String(e),
            }),
          )
        }
        if (mcpConfigPath) {
          await unlink(mcpConfigPath).catch(() => {
            /* best effort */
          })
        }
      }

      // Recurse: re-review after fix
      await this.selfReviewAndFix(task, prInfo, projectPath, prUrl, round + 1)
    } catch (err) {
      log.warn('Self-review failed', {
        prUrl,
        round,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Feishu notifications                                             */
  /* ---------------------------------------------------------------- */

  private async notifyCompletion(task: Task): Promise<void> {
    const chatId = task.metadata?.imChatId as string | undefined
    if (!chatId || !this.imPlatform) return

    const title = (task.metadata!.title as string) || task.id
    const summaryText = this.formatTaskSummary(task)
    const prLine = task.prUrl ? `\n\n🔗 **PR:** ${task.prUrl}` : ''
    const cardBody = `📋 Task ID: \`${task.id}\`\n\n${summaryText}${prLine}`
    const card = {
      markdown: cardBody,
      header: { title: `✅ Task Completed: ${title}`, color: 'green' },
    }
    const cardMsgId = task.metadata!.imCardMessageId as string | undefined
    const replyTo = task.metadata!.imMessageId as string | undefined

    try {
      if (cardMsgId) {
        await this.imPlatform.updateCard(cardMsgId, card)
      } else {
        await this.imPlatform.sendCard(chatId, card, { replyTo })
      }
    } catch (e) {
      log.warn('Notify complete failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async notifyFailure(task: Task): Promise<void> {
    const chatId = task.metadata?.imChatId as string | undefined
    if (!chatId || !this.imPlatform) return

    const title = (task.metadata!.title as string) || task.id
    const cardBody = `📋 Task ID: \`${task.id}\`\n\n**Error:** ${task.error || 'Unknown error'}`
    const card = { markdown: cardBody, header: { title: `❌ Task Failed: ${title}`, color: 'red' } }
    const cardMsgId = task.metadata!.imCardMessageId as string | undefined
    const replyTo = task.metadata!.imMessageId as string | undefined

    try {
      if (cardMsgId) {
        await this.imPlatform.updateCard(cardMsgId, card)
      } else {
        await this.imPlatform.sendCard(chatId, card, { replyTo })
      }
    } catch (e) {
      log.warn('Notify failure failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async notifyIssueResult(task: Task): Promise<void> {
    const meta = task.metadata
    if (!meta?.issueNumber || !meta?.issueRepoOwner || !meta?.issueRepoName) return
    if (!this.githubClient) return

    const owner = meta.issueRepoOwner as string
    const repo = meta.issueRepoName as string
    const issueNumber = meta.issueNumber as number
    const host = (meta.issueHost as string) || 'github.com'

    let body: string
    if (task.status === 'completed' && task.prUrl) {
      body = `**DevOps Bot:** Task completed.\n\n**PR:** ${task.prUrl}`
    } else if (task.status === 'completed') {
      const thinking = task.summary?.thinking
      const reason = thinking ? `\n\n**Analysis:**\n${thinking}` : ''
      body = `**DevOps Bot:** Task completed but no code changes were made.${reason}`
    } else {
      body = `**DevOps Bot:** Task failed.\n\n**Error:** ${task.error || 'Unknown error'}`
    }

    try {
      if ((meta.issuePlatform as string) === 'gitlab') {
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
      } else {
        await this.githubClient.createIssueComment(owner, repo, issueNumber, body, host)
      }
    } catch (err) {
      log.warn('Failed to post issue result comment', {
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private formatTaskSummary(task: Task): string {
    const parts: string[] = []
    if (task.summary?.thinking) {
      parts.push(`**Approach:**\n${task.summary.thinking}`)
    }
    if (task.summary?.modifiedFiles?.length) {
      parts.push(
        `**Modified files:**\n${task.summary.modifiedFiles.map((f) => `- ${f}`).join('\n')}`,
      )
    }
    if (parts.length === 0) {
      parts.push('Task completed')
    }
    return parts.join('\n\n')
  }

  /* ---------------------------------------------------------------- */
  /*  Memory feedback                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Write the task result into the chat message history so the dispatcher
   * can reference the correct PR number / status in follow-up messages.
   */
  private async recordCompletionInChat(task: Task, projectPath: string): Promise<void> {
    const chatId = task.metadata?.imChatId as string | undefined
    if (!chatId) return

    try {
      const store = await getMemoryStore()
      const title = (task.metadata?.title as string) || task.id
      const parts = [`Task ${task.status}: ${title}`]
      if (task.prUrl) parts.push(`PR: ${task.prUrl}`)
      if (task.status === 'failed' && task.error) parts.push(`Error: ${task.error.slice(0, 200)}`)
      store.addMessage(
        chatId,
        { role: 'assistant', content: parts.join('\n'), timestamp: new Date().toISOString() },
        projectPath,
      )
    } catch {
      // best effort
    }
  }

  private async memorizeTaskLifecycle(task: Task, projectPath: string): Promise<void> {
    try {
      const store = await getMemoryStore()
      if (!this.memoryExtractor) {
        this.memoryExtractor = new MemoryExtractor(store)
      }
      this.memoryExtractor.memorizeTaskInput(task, projectPath)
      if (task.status === 'completed' && task.summary) {
        await this.memoryExtractor.memorizeTaskResult(task, projectPath)
      }
    } catch (err) {
      log.error('Failed to memorize task lifecycle', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async memorizeTaskFailure(task: Task, projectPath: string): Promise<void> {
    try {
      const store = await getMemoryStore()
      if (!this.memoryExtractor) {
        this.memoryExtractor = new MemoryExtractor(store)
      }
      this.memoryExtractor.memorizeTaskFailure(task, projectPath)
    } catch (err) {
      log.error('Failed to memorize task failure', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function parsePRUrl(
  url: string,
): { owner: string; repo: string; prNumber: number; host: string } | null {
  // GitHub: https://github.com/owner/repo/pull/123
  // GHE: https://ghe.example.com/owner/repo/pull/123
  const match = url.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (match) {
    return {
      host: match[1],
      owner: match[2],
      repo: match[3],
      prNumber: parseInt(match[4], 10),
    }
  }
  return null
}

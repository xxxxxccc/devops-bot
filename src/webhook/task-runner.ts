/**
 * Task Runner — queue management, AI execution, lifecycle callbacks.
 *
 * Owns the task queue (serial execution, one at a time) and orchestrates:
 * - AI execution via AIExecutor
 * - MCP config generation
 * - SSE event broadcasting
 * - IM platform notifications (card updates)
 * - Memory feedback (task_input / task_result / task_failure)
 */

import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { Task, WebhookConfig } from '../core/types.js'
import { TaskStore } from '../core/task-store.js'
import { createLogger } from '../infra/logger.js'
import { getMemoryStore } from '../memory/store.js'
import { MemoryExtractor } from '../memory/extractor.js'
import { ProjectScanner } from '../prompt/project-scanner.js'
import { SkillScanner } from '../prompt/skill-scanner.js'
import { type Sandbox, SandboxManager } from '../sandbox/manager.js'
import type { SSEManager } from './sse.js'
import { buildExecutorSystemPrompt, detectJiraLinks, detectFigmaLinks } from './prompt.js'

const log = createLogger('task-runner')

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_PATH = join(__dirname, '..', '..', 'dist', 'mcp', 'server.js')

export class TaskRunner {
  readonly store: TaskStore
  private sse: SSEManager

  // Queue state
  private taskQueue: Array<{
    taskId: string
    prompt: string
    metadata?: Record<string, unknown>
  }> = []
  private isProcessingQueue = false

  // Running process handles (for stop support)
  private runningProcesses: Map<string, ChildProcess> = new Map()
  private runningAbortControllers: Map<string, AbortController> = new Map()

  // IM platform reference for task notifications
  private imPlatform: import('../channels/types.js').IMPlatform | null = null
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
  }

  async init(): Promise<void> {
    await this.store.init()
  }

  get queueLength(): number {
    return this.taskQueue.length
  }

  get isProcessing(): boolean {
    return this.isProcessingQueue
  }

  setIMPlatform(platform: import('../channels/types.js').IMPlatform): void {
    this.imPlatform = platform
  }

  /* ---------------------------------------------------------------- */
  /*  Public: enqueue a task                                           */
  /* ---------------------------------------------------------------- */

  async runTask(
    taskId: string,
    prompt: string,
    metadata?: Record<string, unknown>,
    createdBy?: string,
  ): Promise<void> {
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

    this.taskQueue.push({ taskId, prompt, metadata })
    log.info(`Task ${taskId} queued`, { position: this.taskQueue.length })

    this.processQueue()
  }

  /* ---------------------------------------------------------------- */
  /*  Public: stop a running task                                      */
  /* ---------------------------------------------------------------- */

  stopTask(taskId: string): boolean {
    // Try child process (legacy CLI mode)
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

    // Try AbortController (Claude API mode)
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

    return !!(childProcess || abortController)
  }

  /* ---------------------------------------------------------------- */
  /*  Queue processing                                                 */
  /* ---------------------------------------------------------------- */

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.taskQueue.length === 0) return

    this.isProcessingQueue = true
    const { taskId, prompt, metadata } = this.taskQueue.shift()!

    // Mark running
    const runningTask = this.store.update(taskId, { status: 'running' })
    if (runningTask) {
      this.sse.broadcastTaskEvent({
        type: 'task_updated',
        task: runningTask,
        timestamp: new Date().toISOString(),
      })
    }

    log.info(`Task ${taskId} starting`, { queueRemaining: this.taskQueue.length })

    let sandbox: Sandbox | undefined
    let mcpConfigPath: string | undefined

    try {
      // Create sandbox (isolated worktree + branch)
      const taskTitle = (metadata?.title as string) || taskId
      sandbox = await this.sandboxManager.createSandbox(taskId, taskTitle, this.config.projectPath)

      // MCP config points to the sandbox worktree, not the original project
      mcpConfigPath = await this.createMCPConfig(sandbox.worktreePath)
      const task = this.store.get(taskId)
      const output = await this.executeAI(prompt, mcpConfigPath, task!, sandbox)

      // Finalize: push branch + create PR
      const { prUrl } = await this.sandboxManager.finalizeSandbox(sandbox, taskTitle, task?.prompt)

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
        await this.memorizeTaskLifecycle(updatedTask)
        await this.notifyCompletion(updatedTask)
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
        await this.memorizeTaskFailure(failedTask)
        await this.notifyFailure(failedTask)
      }

      log.error(`Task ${taskId} failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      // Always clean up sandbox and MCP config
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

      this.isProcessingQueue = false
      this.processQueue()
    }
  }

  /* ---------------------------------------------------------------- */
  /*  AI execution                                                     */
  /* ---------------------------------------------------------------- */

  private async executeAI(
    prompt: string,
    mcpConfigPath: string,
    task: Task,
    sandbox?: Sandbox,
  ): Promise<string> {
    const { AIExecutor } = await import('../agent/ai-executor.js')
    const { createProviderFromEnv } = await import('../providers/index.js')

    const provider = await createProviderFromEnv()

    const devopsRoot = join(__dirname, '..', '..')
    const projectRules = this.projectScanner.getProjectRules(this.config.projectPath)
    const skills = this.skillScanner.getSkills(devopsRoot, this.config.projectPath)
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
    const effectivePath = targetProjectPath || this.config.projectPath

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
  /*  Feishu notifications                                             */
  /* ---------------------------------------------------------------- */

  private async notifyCompletion(task: Task): Promise<void> {
    const chatId = task.metadata?.imChatId as string | undefined
    if (!chatId || !this.imPlatform) return

    const title = (task.metadata!.title as string) || task.id
    const summaryText = this.formatTaskSummary(task)
    const prLine = task.prUrl ? `\n\n🔗 **PR:** ${task.prUrl}` : ''
    const cardBody = `📋 任务ID: \`${task.id}\`\n\n${summaryText}${prLine}`
    const card = { markdown: cardBody, header: { title: `✅ 任务完成: ${title}`, color: 'green' } }
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
    const cardBody = `📋 任务ID: \`${task.id}\`\n\n**错误:** ${task.error || '未知错误'}`
    const card = { markdown: cardBody, header: { title: `❌ 任务失败: ${title}`, color: 'red' } }
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

  private formatTaskSummary(task: Task): string {
    const parts: string[] = []
    if (task.summary?.thinking) {
      parts.push(`**思路:**\n${task.summary.thinking}`)
    }
    if (task.summary?.modifiedFiles?.length) {
      parts.push(`**修改文件:**\n${task.summary.modifiedFiles.map((f) => `- ${f}`).join('\n')}`)
    }
    if (parts.length === 0) {
      parts.push('任务已完成')
    }
    return parts.join('\n\n')
  }

  /* ---------------------------------------------------------------- */
  /*  Memory feedback                                                  */
  /* ---------------------------------------------------------------- */

  private async memorizeTaskLifecycle(task: Task): Promise<void> {
    try {
      const store = await getMemoryStore()
      if (!this.memoryExtractor) {
        this.memoryExtractor = new MemoryExtractor(store)
      }
      this.memoryExtractor.memorizeTaskInput(task, this.config.projectPath)
      if (task.status === 'completed' && task.summary) {
        await this.memoryExtractor.memorizeTaskResult(task, this.config.projectPath)
      }
    } catch (err) {
      log.error('Failed to memorize task lifecycle', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async memorizeTaskFailure(task: Task): Promise<void> {
    try {
      const store = await getMemoryStore()
      if (!this.memoryExtractor) {
        this.memoryExtractor = new MemoryExtractor(store)
      }
      this.memoryExtractor.memorizeTaskFailure(task, this.config.projectPath)
    } catch (err) {
      log.error('Failed to memorize task failure', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Webhook Server — slim orchestrator.
 *
 * Wires together the sub-modules and exposes the public API consumed
 * by `index.ts` and the Dispatcher.
 *
 * Sub-modules:
 *   - sse.ts         — SSE real-time client management
 *   - task-runner.ts — task queue, AI execution, notifications, memory
 *   - routes.ts      — Express route handlers
 *   - prompt.ts      — Layer 2 prompt building
 */

import express from 'express'
import type { WebhookConfig } from '../core/types.js'
import { SSEManager } from './sse.js'
import { TaskRunner } from './task-runner.js'
import { setupMiddleware, setupRoutes } from './routes.js'
import { buildTaskPrompt } from './prompt.js'
import type { ProjectResolver } from '../project/resolver.js'
import { ApprovalStore } from '../approval/store.js'
import { ApprovalPoller } from '../approval/poller.js'
import { getGitHubClient } from '../github/client.js'

export class WebhookServer {
  private app = express()
  private runner: TaskRunner
  private sse = new SSEManager()
  private config: WebhookConfig
  private _projectResolver: ProjectResolver | null = null
  private _approvalStore: ApprovalStore | null = null
  private _approvalPoller: ApprovalPoller | null = null

  constructor(config: WebhookConfig) {
    this.config = config
    this.runner = new TaskRunner(config, this.sse)

    setupMiddleware(this.app)
    setupRoutes(this.app, this.runner, this.sse, config)
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  /** Get the target project path (undefined in multi-project mode) */
  getProjectPath(): string | undefined {
    return this.config.projectPath
  }

  /** Get the project resolver (initialized on first access) */
  async getProjectResolver(): Promise<ProjectResolver> {
    if (!this._projectResolver) {
      const { getMemoryStore } = await import('../memory/store.js')
      const store = await getMemoryStore()
      const { ProjectResolver } = await import('../project/resolver.js')
      this._projectResolver = new ProjectResolver(
        (store as any).getDatabase(),
        this.config.projectPath,
      )
      this._projectResolver.init()
    }
    return this._projectResolver
  }

  /** Set the IM platform for task notifications and wire up the poller */
  setIMPlatform(platform: import('../channels/types.js').IMPlatform): void {
    this.runner.setIMPlatform(platform)
    if (this._approvalPoller) {
      ;(this._approvalPoller as any).deps.imPlatform = platform
    }
  }

  /** Get the approval store (initialized during start) */
  getApprovalStore(): ApprovalStore | null {
    return this._approvalStore
  }

  /** Merge additional metadata into an existing task */
  updateTaskMetadata(taskId: string, extra: Record<string, unknown>): void {
    const task = this.runner.store.get(taskId)
    if (task) {
      this.runner.store.update(taskId, {
        metadata: { ...task.metadata, ...extra },
      })
    }
  }

  /**
   * Create a task from an IM platform message.
   * Returns the task ID.
   */
  async createTaskFromIM(data: {
    title: string
    description: string
    createdBy: string
    projectPath?: string
    metadata?: Record<string, unknown>
    attachments?: Array<{
      filename: string
      originalname: string
      path: string
      mimetype?: string
    }>
  }): Promise<string> {
    const taskId = `task-${Date.now()}`

    const language = (data.metadata?.language as string) || undefined

    const prompt = buildTaskPrompt({
      taskId,
      title: data.title,
      description: data.description,
      language,
      attachments: data.attachments,
    })

    const effectivePath = data.projectPath || this.config.projectPath || ''
    this.runner
      .runTask(
        taskId,
        prompt,
        { ...data.metadata, title: data.title },
        data.createdBy,
        effectivePath,
      )
      .catch(console.error)

    return taskId
  }

  private async initApprovalPoller(): Promise<void> {
    try {
      const { getMemoryStore } = await import('../memory/store.js')
      const store = await getMemoryStore()
      const db = (store as any).getDatabase()

      this._approvalStore = new ApprovalStore(db)
      this._approvalStore.init()

      const githubClient = await getGitHubClient()
      const intervalMs = Number.parseInt(process.env.APPROVAL_POLL_INTERVAL_MS || '1800000', 10)

      this._approvalPoller = new ApprovalPoller(
        {
          approvalStore: this._approvalStore,
          githubClient,
          imPlatform: (this.runner as any).imPlatform ?? null,
          getProjectRegistry: async () => {
            try {
              const resolver = await this.getProjectResolver()
              return resolver.getRegistry()
            } catch {
              return null
            }
          },
          createTask: (data) => this.createTaskFromIM(data),
        },
        intervalMs,
      )
      this._approvalPoller.start()
    } catch (err) {
      console.error('Failed to initialize approval poller:', err)
    }
  }

  /** Start the Express server and approval poller */
  async start(): Promise<void> {
    await this.runner.init()
    await this.initApprovalPoller()

    this.app.listen(this.config.port, () => {
      console.log(`
      ╔══════════════════════════════════════════════════╗
      ║     DevOps Bot Webhook Server           ║
      ╠══════════════════════════════════════════════════╣
      ║  Port:     ${this.config.port.toString().padEnd(39)}║
      ║  Project:  ${(this.config.projectPath || 'multi-project').slice(-37).padEnd(39)}║
      ╚══════════════════════════════════════════════════╝

      Endpoints:
        GET  /health          - Health check
        GET  /tools           - List available tools
        GET  /tasks           - List all tasks
        POST /webhook/todo    - Receive todo webhook
        POST /task            - Manual task trigger
        GET  /task/:id        - Get task status
        PATCH /task/:id       - Update task
        DELETE /task/:id      - Delete task

      Headers required:
        secret: ${this.config.secret.slice(0, 10)}...
    `)
    })
  }
}

// Direct execution support
if (import.meta.url === `file://${process.argv[1]}`) {
  import('dotenv').then((dotenv) => {
    dotenv.config({ path: ['.env.local', '.env'] })

    const config: WebhookConfig = {
      port: parseInt(process.env.WEBHOOK_PORT || '3200', 10),
      secret: process.env.WEBHOOK_SECRET || 'dev-secret',
      projectPath: process.env.TARGET_PROJECT_PATH || '',
    }

    const server = new WebhookServer(config)
    server.start()
  })
}

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

export class WebhookServer {
  private app = express()
  private runner: TaskRunner
  private sse = new SSEManager()
  private config: WebhookConfig

  constructor(config: WebhookConfig) {
    this.config = config
    this.runner = new TaskRunner(config, this.sse)

    setupMiddleware(this.app)
    setupRoutes(this.app, this.runner, this.sse, config)
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  /** Get the target project path */
  getProjectPath(): string {
    return this.config.projectPath
  }

  /** Set the IM platform for task notifications */
  setIMPlatform(platform: import('../channels/types.js').IMPlatform): void {
    this.runner.setIMPlatform(platform)
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
    metadata?: Record<string, unknown>
    attachments?: Array<{
      filename: string
      originalname: string
      path: string
      mimetype?: string
    }>
  }): Promise<string> {
    const taskId = `task-${Date.now()}`

    const prompt = buildTaskPrompt({
      taskId,
      title: data.title,
      description: data.description,
      attachments: data.attachments,
    })

    this.runner
      .runTask(taskId, prompt, { ...data.metadata, title: data.title }, data.createdBy)
      .catch(console.error)

    return taskId
  }

  /** Start the Express server */
  async start(): Promise<void> {
    await this.runner.init()

    this.app.listen(this.config.port, () => {
      console.log(`
      ╔══════════════════════════════════════════════════╗
      ║     DevOps Bot Webhook Server           ║
      ╠══════════════════════════════════════════════════╣
      ║  Port:     ${this.config.port.toString().padEnd(39)}║
      ║  Project:  ${this.config.projectPath.slice(-37).padEnd(39)}║
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

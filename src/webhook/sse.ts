/**
 * SSE (Server-Sent Events) Manager
 *
 * Manages real-time client connections and event broadcasting.
 * Supports per-task watching so output updates are only sent to
 * clients that are actively viewing the relevant task.
 */

import type { Request, Response } from 'express'
import type { Task } from '../core/types.js'

export interface SSEClient {
  id: string
  res: Response
  /** If set, this client receives output updates for this specific task */
  watchingTaskId?: string
}

export interface TaskEvent {
  type: 'task_created' | 'task_updated' | 'task_completed' | 'task_failed'
  task: Task
  timestamp: string
}

export class SSEManager {
  private clients: SSEClient[] = []

  get clientCount(): number {
    return this.clients.length
  }

  /**
   * Handle a new SSE connection (GET /events).
   */
  handleConnection(req: Request, res: Response, initialTasks: Task[]): void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const watchingTaskId = req.query.taskId as string | undefined

    const client: SSEClient = { id: clientId, res, watchingTaskId }
    this.clients.push(client)

    console.log(
      `[SSE] Client connected: ${clientId}${watchingTaskId ? ` (watching: ${watchingTaskId})` : ''} (total: ${this.clients.length})`,
    )

    // Send connection ack
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, watchingTaskId })}\n\n`)

    // Send current task snapshot (without full output)
    const tasks = initialTasks.map((t) => ({
      ...t,
      output: t.output ? `[${t.output.length} chars]` : '',
    }))
    res.write(`event: init\ndata: ${JSON.stringify({ tasks })}\n\n`)

    // Heartbeat
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 30000)

    req.on('close', () => {
      clearInterval(heartbeat)
      this.clients = this.clients.filter((c) => c.id !== clientId)
      console.log(`[SSE] Client disconnected: ${clientId} (remaining: ${this.clients.length})`)
    })
  }

  /**
   * Update which task a client is watching (POST /watch).
   */
  handleWatch(req: Request, res: Response): void {
    const { clientId, taskId } = req.body
    const client = this.clients.find((c) => c.id === clientId)

    if (client) {
      client.watchingTaskId = taskId || undefined
      console.log(`[SSE] Client ${clientId} now watching: ${taskId || 'none'}`)
      res.json({ success: true })
    } else {
      res.status(404).json({ error: 'Client not found' })
    }
  }

  /**
   * Broadcast a task lifecycle event (created/updated/completed/failed)
   * to ALL connected clients (without full output).
   */
  broadcastTaskEvent(event: TaskEvent): void {
    const eventForBroadcast = {
      ...event,
      task: {
        ...event.task,
        output: event.task.output ? `[${event.task.output.length} chars]` : '',
      },
    }
    const data = JSON.stringify(eventForBroadcast)
    const message = `event: task\ndata: ${data}\n\n`

    for (const client of this.clients) {
      try {
        client.res.write(message)
      } catch (error) {
        console.error(`[SSE] Failed to send to client ${client.id}:`, error)
      }
    }

    console.log(
      `[SSE] Broadcasted ${event.type} for task ${event.task.id} to ${this.clients.length} clients`,
    )
  }

  /**
   * Broadcast task output update only to clients watching this specific task.
   */
  broadcastTaskOutput(task: Task): void {
    const watchingClients = this.clients.filter((c) => c.watchingTaskId === task.id)
    if (watchingClients.length === 0) return

    const event: TaskEvent = {
      type: 'task_updated',
      task,
      timestamp: new Date().toISOString(),
    }
    const data = JSON.stringify(event)
    const message = `event: task\ndata: ${data}\n\n`

    for (const client of watchingClients) {
      try {
        client.res.write(message)
      } catch (error) {
        console.error(`[SSE] Failed to send output to client ${client.id}:`, error)
      }
    }

    console.log(
      `[SSE] Sent output update for task ${task.id} to ${watchingClients.length} watching clients`,
    )
  }
}

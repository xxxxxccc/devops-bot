/**
 * Express Routes — HTTP request handlers.
 *
 * Pure route definitions that delegate to TaskRunner, SSEManager,
 * and prompt builders.  No business logic lives here.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Express, Request, Response } from 'express'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import type { Task, WebhookConfig } from '../core/types.js'
import type { TaskRunner } from './task-runner.js'
import type { SSEManager } from './sse.js'
import { buildTaskPrompt, buildContinuedPrompt } from './prompt.js'

/* ------------------------------------------------------------------ */
/*  File upload setup                                                  */
/* ------------------------------------------------------------------ */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ATTACHMENTS_DIR = join(__dirname, '..', '..', 'data', 'attachments')

if (!existsSync(ATTACHMENTS_DIR)) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ATTACHMENTS_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const ext = file.originalname.split('.').pop()
    cb(null, `${uniqueSuffix}.${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'text/plain',
      'text/html',
      'text/css',
      'text/javascript',
      'text/csv',
      'text/markdown',
      'application/pdf',
      'application/json',
      'application/zip',
      'application/xml',
      'application/octet-stream',
    ]
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`))
    }
  },
})

/* ------------------------------------------------------------------ */
/*  Route setup                                                        */
/* ------------------------------------------------------------------ */

export function setupMiddleware(app: Express): void {
  app.use(cors({ origin: true, credentials: true }))
  app.use(express.json())
  app.use((req: Request, _res: Response, next: () => void) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
    next()
  })
}

export function setupRoutes(
  app: Express,
  runner: TaskRunner,
  sse: SSEManager,
  config: WebhookConfig,
): void {
  const verifySecret = (req: Request): boolean => {
    const secret =
      (req.headers.secret as string) ||
      (req.headers.authorization as string)?.replace('Bearer ', '')
    return secret === config.secret
  }

  // Static attachments (used by ATTACHMENT_STORAGE=local)
  app.use('/attachments', express.static(ATTACHMENTS_DIR))

  // Health
  app.get('/health', (_req, res) => {
    const stats = runner.store.getStats()
    const projectName = config.projectPath?.split('/').pop() || 'multi-project'
    res.json({
      status: 'ok',
      version: '2.0.0',
      tasks: stats,
      project: config.projectPath || '(multi-project mode)',
      projectName,
      sseClients: sse.clientCount,
      queue: { length: runner.queueLength, processing: runner.isProcessing },
    })
  })

  // SSE
  app.get('/events', (req, res) => sse.handleConnection(req, res, runner.store.getAll()))
  app.post('/watch', (req, res) => sse.handleWatch(req, res))

  // Task CRUD
  app.get('/tasks', (req, res) => handleListTasks(req, res, runner))
  app.get('/task/:id', (req, res) => handleGetTask(req, res, runner))
  app.patch('/task/:id', (req, res) => handleUpdateTask(req, res, runner, sse))
  app.delete('/task/:id', (req, res) => handleDeleteTask(req, res, runner))

  // Task actions
  app.post('/task/:id/retry', (req, res) => handleRetryTask(req, res, runner))
  app.post('/task/:id/stop', (req, res) => handleStopTask(req, res, runner))
  app.post('/task/:id/continue', (req, res) => handleContinueTask(req, res, runner))

  // Webhook & manual task
  app.post('/webhook/todo', (req, res) => handleWebhook(req, res, runner, verifySecret))
  app.post('/task', (req, res) => handleManualTask(req, res, runner, verifySecret))

  // GitHub webhook (PR review trigger)
  app.post('/webhook/github', express.json(), (req, res) => handleGitHubWebhook(req, res, runner))

  // Upload
  app.post('/upload', upload.array('files', 10), (req, res) => handleUpload(req, res, verifySecret))

  // Tools listing
  app.get('/tools', (_req, res) => {
    res.json({
      categories: [
        {
          name: 'file',
          tools: ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_directory'],
        },
        { name: 'search', tools: ['glob_search', 'grep_search'] },
        { name: 'git', tools: ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_push'] },
        { name: 'shell', tools: ['shell_exec', 'npm'] },
      ],
      note: 'These tools are available via MCP when running Kimi CLI',
    })
  })
}

/* ------------------------------------------------------------------ */
/*  Handler functions                                                  */
/* ------------------------------------------------------------------ */

function handleListTasks(req: Request, res: Response, runner: TaskRunner): void {
  const { status, limit = '50', offset = '0' } = req.query
  let tasks = status ? runner.store.getByStatus(status as Task['status']) : runner.store.getAll()

  const total = tasks.length
  const limitNum = parseInt(limit as string, 10)
  const offsetNum = parseInt(offset as string, 10)
  tasks = tasks.slice(offsetNum, offsetNum + limitNum)

  res.json({ tasks, total, limit: limitNum, offset: offsetNum })
}

function handleGetTask(req: Request, res: Response, runner: TaskRunner): void {
  const task = runner.store.get(req.params.id as string)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  res.json(task)
}

function handleUpdateTask(req: Request, res: Response, runner: TaskRunner, sse: SSEManager): void {
  const id = req.params.id as string
  const { status, metadata, summary } = req.body
  const task = runner.store.get(id)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  const updates: Partial<Task> = {}
  if (status) updates.status = status
  if (metadata) updates.metadata = { ...task.metadata, ...metadata }
  if (summary) updates.summary = summary

  const updated = runner.store.update(id, updates)
  if (summary && updated) {
    sse.broadcastTaskEvent({
      type: 'task_updated',
      task: updated,
      timestamp: new Date().toISOString(),
    })
  }
  res.json(updated)
}

function handleDeleteTask(req: Request, res: Response, runner: TaskRunner): void {
  const id = req.params.id as string
  const deleted = runner.store.delete(id)
  if (!deleted) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  res.json({ success: true, id })
}

async function handleRetryTask(req: Request, res: Response, runner: TaskRunner): Promise<void> {
  const id = req.params.id as string
  const { createdBy } = req.body
  const existingTask = runner.store.get(id)

  if (!existingTask) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  if (existingTask.status === 'running') {
    res.status(400).json({ error: 'Task is already running' })
    return
  }

  const newTaskId = `task-${Date.now()}`
  res.json({ taskId: newTaskId, status: 'queued', retryOf: id })

  const updatedPrompt = existingTask.prompt
    .replace(/\*\*Task ID:\*\*\s*task-\d+/g, `**Task ID:** ${newTaskId}`)
    .replace(/task_id="task-\d+"/g, `task_id="${newTaskId}"`)

  runner.runTask(newTaskId, updatedPrompt, existingTask.metadata, createdBy).catch(console.error)
}

function handleStopTask(req: Request, res: Response, runner: TaskRunner): void {
  const id = req.params.id as string
  const task = runner.store.get(id)

  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  if (task.status !== 'running') {
    res.status(400).json({ error: 'Task is not running' })
    return
  }

  console.log(`[Task ${id}] Stopping task...`)
  runner.stopTask(id)
  res.json({ success: true, message: 'Task stopped' })
}

async function handleContinueTask(req: Request, res: Response, runner: TaskRunner): Promise<void> {
  const id = req.params.id as string
  const { instruction, attachments, createdBy } = req.body

  if (!instruction) {
    res.status(400).json({ error: 'Missing required field: instruction' })
    return
  }

  const existingTask = runner.store.get(id)
  if (!existingTask) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  if (existingTask.status === 'running') {
    res.status(400).json({ error: 'Task is still running' })
    return
  }

  const newTaskId = `task-${Date.now()}`
  const continuedPrompt = buildContinuedPrompt(existingTask, instruction, newTaskId, attachments)

  res.json({ taskId: newTaskId, status: 'queued', continueOf: id })

  runner
    .runTask(newTaskId, continuedPrompt, { ...existingTask.metadata, continueOf: id }, createdBy)
    .catch(console.error)
}

async function handleWebhook(
  req: Request,
  res: Response,
  runner: TaskRunner,
  verifySecret: (req: Request) => boolean,
): Promise<void> {
  if (!verifySecret(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { todoId, title, mailBody } = req.body
  if (!title) {
    res.status(400).json({ error: 'Missing required field: title' })
    return
  }

  const taskId = `task-${Date.now()}`
  res.json({ taskId, status: 'queued' })

  const prompt = buildTaskPrompt({ taskId, title, description: mailBody, todoId })
  runner.runTask(taskId, prompt, { todoId, title }).catch(console.error)
}

async function handleManualTask(
  req: Request,
  res: Response,
  runner: TaskRunner,
  verifySecret: (req: Request) => boolean,
): Promise<void> {
  if (!verifySecret(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { task: description, title, attachments, createdBy } = req.body
  if (!description && !title) {
    res.status(400).json({ error: 'Missing required field: task or title' })
    return
  }

  const taskId = `task-${Date.now()}`
  res.json({ taskId, status: 'queued' })

  const taskTitle = title || description.slice(0, 100)
  const prompt = buildTaskPrompt({
    taskId,
    title: taskTitle,
    description,
    attachments: attachments as Array<{ filename: string; originalname: string; path: string }>,
  })
  runner.runTask(taskId, prompt, { title: taskTitle }, createdBy).catch(console.error)
}

async function handleGitHubWebhook(
  req: Request,
  res: Response,
  _runner: TaskRunner,
): Promise<void> {
  const event = req.headers['x-github-event'] as string
  if (event !== 'pull_request') {
    res.json({ ignored: true, event })
    return
  }

  const { action, pull_request, repository } = req.body
  if (!pull_request || !repository) {
    res.status(400).json({ error: 'Invalid payload' })
    return
  }

  if (action !== 'opened' && action !== 'synchronize') {
    res.json({ ignored: true, action })
    return
  }

  const triggerMode = process.env.REVIEW_TRIGGER_MODE || 'polling'
  if (triggerMode !== 'webhook' && triggerMode !== 'both') {
    res.json({ ignored: true, reason: 'webhook mode not enabled' })
    return
  }

  res.json({ accepted: true, prNumber: pull_request.number })

  try {
    const { getGitHubClient } = await import('../github/client.js')
    const { ReviewEngine } = await import('../review/engine.js')
    const { ReviewStore } = await import('../review/store.js')
    const { MemoryRetriever } = await import('../memory/retriever.js')
    const { getMemoryStore } = await import('../memory/store.js')

    const githubClient = await getGitHubClient()
    const memoryStore = await getMemoryStore()
    const db = (memoryStore as any).getDatabase()

    const reviewStore = new ReviewStore(db)
    reviewStore.init()

    const headSHA = pull_request.head?.sha || pull_request.updated_at
    const owner = repository.owner?.login || ''
    const repo = repository.name || ''

    if (reviewStore.isReviewed(owner, repo, pull_request.number, headSHA)) {
      return
    }

    const engine = new ReviewEngine({
      githubClient,
      memoryStore,
      memoryRetriever: new MemoryRetriever(memoryStore),
    })

    const result = await engine.reviewPR({
      owner,
      repo,
      prNumber: pull_request.number,
      projectPath: '',
      trigger: 'webhook',
    })

    reviewStore.markReviewed(
      owner,
      repo,
      pull_request.number,
      headSHA,
      result.reviewId ?? null,
      'webhook',
    )
  } catch (err) {
    console.error('GitHub webhook review failed:', err)
  }
}

function handleUpload(req: Request, res: Response, verifySecret: (req: Request) => boolean): void {
  if (!verifySecret(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const files = req.files as Express.Multer.File[]
  if (!files || files.length === 0) {
    res.status(400).json({ error: 'No files uploaded' })
    return
  }

  res.json({
    success: true,
    files: files.map((file) => ({
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path,
    })),
  })
}

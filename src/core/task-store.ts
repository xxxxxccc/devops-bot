/**
 * Task persistent storage — JSON file backed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Task } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_PATH = join(__dirname, '..', '..', 'data', 'tasks.json')

export interface TaskStoreOptions {
  filePath?: string
}

export class TaskStore {
  private filePath: string
  private tasks: Map<string, Task> = new Map()
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(options: TaskStoreOptions = {}) {
    this.filePath = options.filePath || DEFAULT_DATA_PATH
  }

  async init(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const content = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(content) as Task[]

      for (const task of data) {
        this.tasks.set(task.id, task)
      }

      console.log(`[TaskStore] Loaded ${this.tasks.size} tasks from ${this.filePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[TaskStore] No existing data file, starting fresh')
        await this.save()
      } else {
        console.error('[TaskStore] Error loading data:', error)
      }
    }
  }

  /** Get all tasks sorted by creation date (newest first). */
  getAll(): Task[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  /** Filter tasks by status. */
  getByStatus(status: Task['status']): Task[] {
    return this.getAll().filter((t) => t.status === status)
  }

  /** Get a single task by ID. */
  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /** Create or overwrite a task. */
  set(task: Task): void {
    this.tasks.set(task.id, task)
    this.scheduleSave()
  }

  /** Partially update a task. */
  update(id: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined

    const updated = {
      ...task,
      ...updates,
      updatedAt: new Date().toISOString(),
    }
    this.tasks.set(id, updated)
    this.scheduleSave()
    return updated
  }

  /** Delete a task by ID. */
  delete(id: string): boolean {
    const result = this.tasks.delete(id)
    if (result) {
      this.scheduleSave()
    }
    return result
  }

  /** Get aggregate stats. */
  getStats() {
    const all = this.getAll()
    return {
      total: all.length,
      pending: all.filter((t) => t.status === 'pending').length,
      running: all.filter((t) => t.status === 'running').length,
      completed: all.filter((t) => t.status === 'completed').length,
      failed: all.filter((t) => t.status === 'failed').length,
    }
  }

  /** Debounced save. */
  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }
    this.saveTimer = setTimeout(() => {
      this.save().catch(console.error)
    }, 1000)
  }

  /** Flush to disk immediately. */
  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    try {
      const data = this.getAll()
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
      this.dirty = false
      console.log(`[TaskStore] Saved ${data.length} tasks`)
    } catch (error) {
      console.error('[TaskStore] Error saving data:', error)
      throw error
    }
  }

  /** Close the store, flushing pending writes. */
  async close(): Promise<void> {
    if (this.dirty) {
      await this.save()
    }
  }
}

// Global singleton
let globalStore: TaskStore | null = null

export async function getTaskStore(options?: TaskStoreOptions): Promise<TaskStore> {
  if (!globalStore) {
    globalStore = new TaskStore(options)
    await globalStore.init()
  }
  return globalStore
}

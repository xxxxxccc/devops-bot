/**
 * 任务持久化存储
 * 使用 JSON 文件存储任务数据
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

  /**
   * 初始化存储，加载已有数据
   */
  async init(): Promise<void> {
    try {
      // 确保目录存在
      await mkdir(dirname(this.filePath), { recursive: true })

      // 尝试加载已有数据
      const content = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(content) as Task[]

      for (const task of data) {
        this.tasks.set(task.id, task)
      }

      console.log(`[TaskStore] Loaded ${this.tasks.size} tasks from ${this.filePath}`)
    } catch (error) {
      // 文件不存在，使用空数据
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[TaskStore] No existing data file, starting fresh')
        await this.save()
      } else {
        console.error('[TaskStore] Error loading data:', error)
      }
    }
  }

  /**
   * 获取所有任务
   */
  getAll(): Task[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  /**
   * 根据状态筛选任务
   */
  getByStatus(status: Task['status']): Task[] {
    return this.getAll().filter((t) => t.status === status)
  }

  /**
   * 获取单个任务
   */
  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /**
   * 创建或更新任务
   */
  set(task: Task): void {
    this.tasks.set(task.id, task)
    this.scheduleSave()
  }

  /**
   * 更新任务
   */
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

  /**
   * 删除任务
   */
  delete(id: string): boolean {
    const result = this.tasks.delete(id)
    if (result) {
      this.scheduleSave()
    }
    return result
  }

  /**
   * 获取统计信息
   */
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

  /**
   * 延迟保存（防抖）
   */
  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }
    this.saveTimer = setTimeout(() => {
      this.save().catch(console.error)
    }, 1000) // 1秒后保存
  }

  /**
   * 立即保存到文件
   */
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

  /**
   * 关闭存储（保存未保存的数据）
   */
  async close(): Promise<void> {
    if (this.dirty) {
      await this.save()
    }
  }
}

// 创建全局实例
let globalStore: TaskStore | null = null

export async function getTaskStore(options?: TaskStoreOptions): Promise<TaskStore> {
  if (!globalStore) {
    globalStore = new TaskStore(options)
    await globalStore.init()
  }
  return globalStore
}

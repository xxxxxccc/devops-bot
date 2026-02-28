/**
 * 任务相关工具
 * 使用 Zod schema 定义参数
 * - submit_summary: AI 完成任务后调用此工具提交结论
 * - get_task_history: 获取历史任务信息
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod'
import { type Tool, defineTool } from '../core/types.js'

/**
 * 获取 tasks.json 的路径
 * 优先使用 DEVOPS_ROOT_PATH 环境变量，回退到相对路径计算
 */
function getTasksFilePath(): string {
  const devopsRoot = process.env.DEVOPS_ROOT_PATH
  if (devopsRoot) {
    return join(devopsRoot, 'data', 'tasks.json')
  }
  // 回退：假设从 dist/tools/ 运行
  return join(process.cwd(), 'data', 'tasks.json')
}

// ============ Schemas ============

const getTaskHistorySchema = z.object({
  limit: z.number().optional().describe('Maximum number of tasks to return (default: 10)'),
  status: z
    .enum(['pending', 'running', 'completed', 'failed', 'all'])
    .optional()
    .describe('Filter by task status (default: all)'),
  search: z.string().optional().describe('Search keyword in task title or description'),
})

const submitSummarySchema = z.object({
  task_id: z.string().describe('The task ID (provided in the task prompt)'),
  modified_files: z.array(z.string()).describe('List of file paths that were modified'),
  thinking: z
    .string()
    .describe(
      'Detailed explanation of changes: what was the problem, how you analyzed it, what changes were made and why',
    ),
})

// ============ Tools ============

export const getTaskHistoryTool = defineTool({
  name: 'get_task_history',
  description:
    'Get information about previous tasks to understand context. Useful when the current task references previous work or needs context about what has been done before.',
  category: 'task',
  schema: getTaskHistorySchema,
  execute: async (args): Promise<string> => {
    const limit = args.limit || 10
    const status = args.status
    const search = args.search

    try {
      const data = JSON.parse(readFileSync(getTasksFilePath(), 'utf-8'))
      // 兼容两种格式：数组 [...] 或对象 {tasks: [...]}
      let tasks: Array<{
        id: string
        status: string
        metadata?: { title?: string }
        prompt?: string
        createdAt: string
        summary?: { modifiedFiles: string[]; thinking: string }
      }> = Array.isArray(data) ? data : data.tasks || []

      // Filter by status
      if (status && status !== 'all') {
        tasks = tasks.filter((t) => t.status === status)
      }

      // Search by keyword
      if (search) {
        const keyword = search.toLowerCase()
        tasks = tasks.filter((t) => {
          const title = t.metadata?.title?.toLowerCase() || ''
          const prompt = t.prompt?.toLowerCase() || ''
          return title.includes(keyword) || prompt.includes(keyword)
        })
      }

      // Sort by creation date (newest first) and limit
      tasks = tasks
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit)

      // Format output
      const result = tasks.map((t) => ({
        id: t.id,
        title: t.metadata?.title || 'Untitled',
        status: t.status,
        createdAt: t.createdAt,
        summary: t.summary
          ? {
              modifiedFiles: t.summary.modifiedFiles,
              thinking:
                t.summary.thinking.length > 200
                  ? `${t.summary.thinking.slice(0, 200)}...`
                  : t.summary.thinking,
            }
          : null,
      }))

      return JSON.stringify(result, null, 2)
    } catch (error) {
      return `Error reading task history: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

export const submitSummaryTool = defineTool({
  name: 'submit_summary',
  description:
    'Submit the final summary after completing a task. Call this tool at the end with the list of modified files and your thinking process.',
  category: 'task',
  schema: submitSummarySchema,
  execute: async (args): Promise<string> => {
    const { task_id: taskId, modified_files: modifiedFiles, thinking } = args

    if (!taskId) {
      return 'Error: task_id is required'
    }

    const apiUrl = process.env.DEVOPS_API_URL
    if (!apiUrl) {
      return 'Error: DEVOPS_API_URL not configured'
    }

    try {
      // 通过 API 更新任务的 summary 字段
      const response = await fetch(`${apiUrl}/task/${taskId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: {
            modifiedFiles: modifiedFiles || [],
            thinking: thinking || '',
          },
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        return `Error: ${(errorData as { error?: string }).error || response.statusText}`
      }

      return `Summary submitted successfully for task ${taskId}`
    } catch (error) {
      return `Error updating task: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

export const summaryTools: Tool[] = [getTaskHistoryTool, submitSummaryTool]

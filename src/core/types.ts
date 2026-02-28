/**
 * 工具系统核心类型定义
 * 所有工具必须实现此接口
 */

import type * as z from 'zod'

/**
 * 工具执行上下文
 */
export interface ToolContext {
  /** 目标项目路径 */
  projectPath: string
  /** 任务 ID */
  taskId?: string
  /** Sandbox info when task runs in an isolated worktree */
  sandboxInfo?: {
    branchName: string
    baseBranch: string
    worktreePath: string
  }
  /** 其他上下文数据 */
  metadata?: Record<string, unknown>
}

/**
 * 工具接口 - 所有工具必须实现
 * 使用 Zod schema 定义参数
 */
export interface Tool {
  /** 工具名称 (唯一标识) */
  name: string
  /** 工具描述 */
  description: string
  /** 参数 schema (Zod) */
  schema: z.ZodType
  /** 执行函数 - 参数已通过 schema 验证 */
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>
  /** 工具类别 (用于分组显示) */
  category?: string
  /** 是否启用 */
  enabled?: boolean
}

/**
 * 创建类型安全的工具辅助函数
 */
export function defineTool<T extends z.ZodType>(
  config: Omit<Tool, 'schema' | 'execute'> & {
    schema: T
    execute: (args: z.infer<T>, context: ToolContext) => Promise<string>
  },
): Tool {
  return config as unknown as Tool
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

/**
 * 任务状态
 */
export interface Task {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  prompt: string
  output: string
  error?: string
  createdAt: string
  updatedAt?: string
  createdBy?: string
  metadata?: Record<string, unknown>
  /** PR/MR URL created by the sandbox after task completion */
  prUrl?: string
  summary?: {
    /** 修改的文件列表 */
    modifiedFiles: string[]
    /** 修改思路与逻辑 */
    thinking: string
  }
}

/**
 * MCP Server 配置
 */
export interface MCPServerConfig {
  name: string
  version: string
  projectPath: string
}

/**
 * Webhook Server 配置
 */
export interface WebhookConfig {
  port: number
  secret: string
  projectPath: string
}

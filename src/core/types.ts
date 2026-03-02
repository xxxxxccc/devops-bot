/**
 * Core type definitions for the tool system.
 */

import type * as z from 'zod'

export interface ToolContext {
  projectPath: string
  taskId?: string
  /** Sandbox info when task runs in an isolated worktree */
  sandboxInfo?: {
    branchName: string
    baseBranch: string
    worktreePath: string
  }
  metadata?: Record<string, unknown>
}

export interface Tool {
  name: string
  description: string
  schema: z.ZodType
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>
  category?: string
  enabled?: boolean
}

/** Type-safe tool definition helper. */
export function defineTool<T extends z.ZodType>(
  config: Omit<Tool, 'schema' | 'execute'> & {
    schema: T
    execute: (args: z.infer<T>, context: ToolContext) => Promise<string>
  },
): Tool {
  return config as unknown as Tool
}

/** Tool execution result. */
export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

/** Task state. */
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
    modifiedFiles: string[]
    thinking: string
  }
}

/** MCP Server configuration. */
export interface MCPServerConfig {
  name: string
  version: string
  projectPath: string
}

/** Webhook Server configuration. */
export interface WebhookConfig {
  port: number
  secret: string
  /** Target project path. Optional in multi-project mode. */
  projectPath?: string
  /** Max concurrent tasks (default: 3). Per-project serial, cross-project parallel. */
  maxConcurrentTasks?: number
}

/**
 * 工具集合统一导出
 * 添加新工具时，只需在此文件中导入并注册
 */

import type { Tool } from '../core/types.js'
import { fileTools } from './file-tools.js'
import { createGitTools } from './git-tools.js'
import { shellTools } from './shell-tools.js'
import { summaryTools } from './summary-tool.js'

/**
 * 获取所有工具
 * @param projectPath - 项目路径（Git 工具需要）
 * @returns 所有工具的数组
 */
export function getAllTools(projectPath: string): Tool[] {
  return [...fileTools, ...createGitTools(projectPath), ...shellTools, ...summaryTools]
}

/**
 * 按类别获取工具
 */
export function getToolsByCategory(projectPath: string, category: string): Tool[] {
  return getAllTools(projectPath).filter((t) => t.category === category)
}

/**
 * 工具类别列表 — aligns with tool-policy.ts group names.
 */
export const TOOL_CATEGORIES = [
  { id: 'file', name: 'File Operations', description: 'Read, write, edit, delete files' },
  { id: 'search', name: 'Search', description: 'Find files and search content' },
  { id: 'git', name: 'Git Operations', description: 'Version control operations' },
  { id: 'shell', name: 'Shell Commands', description: 'Execute shell commands' },
  { id: 'task', name: 'Task Management', description: 'Task history and summary submission' },
] as const

// 导出具体工具（方便单独使用）
export * from './file-tools.js'
export * from './git-tools.js'
export * from './shell-tools.js'

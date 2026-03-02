/**
 * Unified tool exports. Register new tools here.
 */

import type { Tool } from '../core/types.js'
import { fileTools } from './file-tools.js'
import { createGitTools } from './git-tools.js'
import { shellTools } from './shell-tools.js'
import { summaryTools } from './summary-tool.js'

/** Get all tools (Git tools require a project path). */
export function getAllTools(projectPath: string): Tool[] {
  return [...fileTools, ...createGitTools(projectPath), ...shellTools, ...summaryTools]
}

/** Get tools by category. */
export function getToolsByCategory(projectPath: string, category: string): Tool[] {
  return getAllTools(projectPath).filter((t) => t.category === category)
}

/** Tool categories — aligns with tool-policy.ts group names. */
export const TOOL_CATEGORIES = [
  { id: 'file', name: 'File Operations', description: 'Read, write, edit, delete files' },
  { id: 'search', name: 'Search', description: 'Find files and search content' },
  { id: 'git', name: 'Git Operations', description: 'Version control operations' },
  { id: 'shell', name: 'Shell Commands', description: 'Execute shell commands' },
  { id: 'task', name: 'Task Management', description: 'Task history and summary submission' },
] as const

// Re-export individual tool modules
export * from './file-tools.js'
export * from './git-tools.js'
export * from './shell-tools.js'

/**
 * 文件操作工具集
 * 使用 Zod schema 定义参数
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { type GlobOptions, glob } from 'glob'
import * as z from 'zod'
import { type Tool, defineTool } from '../core/types.js'

// ============ Schemas ============

const readFileSchema = z.object({
  path: z.string().describe('Absolute path to the file or relative to project root'),
  offset: z.number().optional().describe('Line number to start reading from (1-based)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
})

const writeFileSchema = z.object({
  path: z.string().describe('Absolute path or relative to project root'),
  content: z.string().describe('Content to write'),
  append: z.boolean().optional().describe('Append to file instead of overwriting'),
})

const editFileSchema = z.object({
  path: z.string().describe('File path (absolute or relative to project)'),
  old_string: z.string().describe('The exact string to replace'),
  new_string: z.string().describe('The replacement string'),
  replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
})

const deleteFileSchema = z.object({
  path: z.string().describe('File path to delete'),
})

const listDirectorySchema = z.object({
  path: z.string().describe('Directory path'),
  recursive: z.boolean().optional().describe('List recursively'),
})

const globSearchSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g., "**/*.ts")'),
  exclude: z.string().optional().describe('Exclude pattern (e.g., "node_modules/**")'),
})

const grepSearchSchema = z.object({
  pattern: z.string().describe('Search pattern (regex supported)'),
  path: z.string().optional().describe('Directory to search in (default: project root)'),
  file_pattern: z.string().optional().describe('File glob pattern (e.g., "*.ts")'),
  context_lines: z.number().optional().describe('Number of context lines to show (default: 2)'),
})

// ============ Tools ============

export const readFileTool = defineTool({
  name: 'read_file',
  category: 'file',
  description: 'Read the contents of a file',
  schema: readFileSchema,
  async execute(args, context) {
    const filePath = nodePath.isAbsolute(args.path)
      ? args.path
      : nodePath.join(context.projectPath, args.path)

    const content = await fs.readFile(filePath, 'utf-8')

    // 支持分页读取
    if (args.offset || args.limit) {
      const lines = content.split('\n')
      const offset = (args.offset || 1) - 1
      const limit = args.limit || lines.length
      return lines.slice(offset, offset + limit).join('\n')
    }

    return content
  },
})

export const writeFileTool = defineTool({
  name: 'write_file',
  category: 'file',
  description: 'Write content to a file (creates directories if needed)',
  schema: writeFileSchema,
  async execute(args, context) {
    const filePath = nodePath.isAbsolute(args.path)
      ? args.path
      : nodePath.join(context.projectPath, args.path)

    await fs.mkdir(nodePath.dirname(filePath), { recursive: true })

    if (args.append) {
      await fs.appendFile(filePath, args.content, 'utf-8')
    } else {
      await fs.writeFile(filePath, args.content, 'utf-8')
    }

    return `File ${args.append ? 'appended' : 'written'}: ${filePath}`
  },
})

export const editFileTool = defineTool({
  name: 'edit_file',
  category: 'file',
  description: 'Replace a specific string in a file (exact match)',
  schema: editFileSchema,
  async execute(args, context) {
    const filePath = nodePath.isAbsolute(args.path)
      ? args.path
      : nodePath.join(context.projectPath, args.path)

    const content = await fs.readFile(filePath, 'utf-8')

    if (!content.includes(args.old_string)) {
      throw new Error(`String not found in file: ${args.old_string}`)
    }

    const replaceAll = args.replace_all === true
    const newContent = replaceAll
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string)

    await fs.writeFile(filePath, newContent, 'utf-8')

    const count = (content.match(new RegExp(args.old_string, 'g')) || []).length
    return `File edited: ${filePath} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? 's' : ''})`
  },
})

export const deleteFileTool = defineTool({
  name: 'delete_file',
  category: 'file',
  description: 'Delete a file',
  schema: deleteFileSchema,
  async execute(args, context) {
    const filePath = nodePath.isAbsolute(args.path)
      ? args.path
      : nodePath.join(context.projectPath, args.path)

    await fs.unlink(filePath)
    return `File deleted: ${filePath}`
  },
})

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  category: 'file',
  description: 'List contents of a directory',
  schema: listDirectorySchema,
  async execute(args, context) {
    const dirPath = nodePath.isAbsolute(args.path)
      ? args.path
      : nodePath.join(context.projectPath, args.path)

    const entries = await fs.readdir(dirPath, {
      withFileTypes: true,
      recursive: args.recursive === true,
    })

    return entries
      .map((e) => {
        const prefix = e.isDirectory() ? '[D]' : '[F]'
        return `${prefix} ${e.name}`
      })
      .join('\n')
  },
})

export const globSearchTool = defineTool({
  name: 'glob_search',
  category: 'search',
  description: 'Find files matching a glob pattern',
  schema: globSearchSchema,
  async execute(args, context) {
    const options: GlobOptions = {
      cwd: context.projectPath,
      absolute: true,
      ignore: args.exclude ? [args.exclude] : ['**/node_modules/**', '**/.git/**'],
    }

    const files = await glob(args.pattern, options)
    return files.slice(0, 100).join('\n') || 'No files found'
  },
})

/** Check once at startup whether ripgrep (`rg`) is available on $PATH. */
const hasRipgrep = (() => {
  try {
    execSync('rg --version', { encoding: 'utf-8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

export const grepSearchTool = defineTool({
  name: 'grep_search',
  category: 'search',
  description: 'Search for text in files using ripgrep (falls back to grep)',
  schema: grepSearchSchema,
  async execute(args, context) {
    const searchPath = args.path
      ? nodePath.isAbsolute(args.path)
        ? args.path
        : nodePath.join(context.projectPath, args.path)
      : context.projectPath

    const filePattern = args.file_pattern || '*'
    const contextLines = args.context_lines || 2

    // Escape double-quotes in pattern to prevent shell injection
    const safePattern = args.pattern.replace(/"/g, '\\"')

    // Limit matches at the source to avoid ENOBUFS on large repos
    const maxMatches = 200

    // Build command — prefer rg, fall back to grep -rn
    // Use -m/--max-count to cap matches before piping, preventing buffer overflow
    const cmd = hasRipgrep
      ? `rg -n -m${maxMatches} -C${contextLines} "${safePattern}" --glob "${filePattern}" "${searchPath}" | head -500`
      : `grep -rn -m${maxMatches} --include="${filePattern}" -C${contextLines} "${safePattern}" "${searchPath}" | head -500`

    try {
      const result = execSync(cmd, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      })
      return result || 'No matches found'
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status === 1) return 'No matches found'
      // ENOBUFS: output too large even with limits — return partial result if available
      if (err.message?.includes('ENOBUFS') || err.message?.includes('maxBuffer')) {
        const stdout = (error as { stdout?: string }).stdout
        if (stdout && stdout.length > 0) {
          return `${stdout.slice(0, 50000)}\n\n[Results truncated — too many matches. Try a more specific pattern or path.]`
        }
        return 'Too many matches — output exceeded buffer limit. Please use a more specific search pattern or restrict the search path.'
      }
      throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})

// 导出所有文件工具
export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  listDirectoryTool,
  globSearchTool,
  grepSearchTool,
]

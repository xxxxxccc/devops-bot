/**
 * Shell 命令执行工具集
 * 使用 Zod schema 定义参数，包含安全限制
 */

import { exec, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import * as z from 'zod'
import { type Tool, defineTool } from '../core/types.js'

const execAsync = promisify(exec)

// 危险命令黑名单 (正则表达式)
const DANGEROUS_PATTERNS = [
  /^rm\s+-rf\s+\/($|\s)/i, // rm -rf / 或 rm -rf / xxx
  /^dd\s+if=.*of=\/dev\//i, // dd 写入设备
  /:\(\)\{\s*:\|:&\s*\};/, // Fork bomb
  />\s*\/dev\/null.*>&\s*0/, // 重定向到设备
  /mkfs\.\w+\s+\/dev\//i, // 格式化设备
  /^(curl|wget)\s+.*\|\s*sh/i, // 管道到 shell
]

// 危险命令关键词
const DANGEROUS_KEYWORDS = [
  'rm -rf ~',
  'rm -rf $HOME',
  'rm -rf / ',
  ':(){ :|:& };:',
  'chmod -R 000 /',
  'chmod -R 777 /',
]

function isDangerousCommand(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim()

  // 检查正则模式
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: `Matches dangerous pattern: ${pattern.source}` }
    }
  }

  // 检查关键词
  for (const keyword of DANGEROUS_KEYWORDS) {
    if (trimmed.includes(keyword)) {
      return { safe: false, reason: `Contains dangerous keyword: ${keyword}` }
    }
  }

  return { safe: true }
}

// ============ Schemas ============

const shellExecSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default: 60000)'),
  cwd: z.string().optional().describe('Working directory (default: project root)'),
})

const shellStreamSchema = z.object({
  command: z.string().describe('The command to execute'),
  args: z.array(z.string()).optional().describe('Command arguments as array'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default: 300000 = 5min)'),
})

const npmSchema = z.object({
  script: z.string().describe('npm script to run (e.g., build, test, lint)'),
  args: z.string().optional().describe('Additional arguments'),
})

// ============ Tools ============

export const shellExecTool = defineTool({
  name: 'shell_exec',
  category: 'shell',
  description: 'Execute a shell command with output capture',
  schema: shellExecSchema,
  async execute(args, context) {
    const check = isDangerousCommand(args.command)

    if (!check.safe) {
      throw new Error(`Dangerous command blocked: ${check.reason}`)
    }

    const cwd = args.cwd || context.projectPath
    const timeout = args.timeout || 60000

    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: 'utf-8',
      })

      let result = stdout
      if (stderr) {
        result += `\n[stderr]: ${stderr}`
      }

      return result || '(no output)'
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string; stderr?: string }
      throw new Error(`Command failed (exit ${err.code}): ${err.message}\n${err.stderr || ''}`)
    }
  },
})

export const shellStreamTool = defineTool({
  name: 'shell_stream',
  category: 'shell',
  description: 'Execute a long-running command with streaming output (for build/test)',
  schema: shellStreamSchema,
  async execute(args, context) {
    const check = isDangerousCommand(args.command)

    if (!check.safe) {
      throw new Error(`Dangerous command blocked: ${check.reason}`)
    }

    const cmdArgs = args.args || []
    const timeout = args.timeout || 300000

    return new Promise((resolve, reject) => {
      const child = spawn(args.command, cmdArgs, {
        cwd: context.projectPath,
        shell: cmdArgs.length === 0, // 如果没有 args，使用 shell 模式
      })

      let output = ''
      let errorOutput = ''

      child.stdout.on('data', (data) => {
        output += data.toString()
      })

      child.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Command timed out after ${timeout}ms`))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timeoutId)

        if (code === 0) {
          resolve(output || '(no output)')
        } else {
          reject(new Error(`Exit code ${code}\n${output}\n${errorOutput}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeoutId)
        reject(new Error(`Failed to start: ${err.message}`))
      })
    })
  },
})

export const npmTool = defineTool({
  name: 'npm',
  category: 'shell',
  description: 'Run npm commands (install, build, test, etc.)',
  schema: npmSchema,
  async execute(args, context) {
    const extraArgs = args.args ? ` ${args.args}` : ''
    const command = `npm run ${args.script}${extraArgs}`

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.projectPath,
        timeout: 300000, // 5 minutes for builds
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
      })

      return stdout + (stderr ? `\n[stderr]: ${stderr}` : '')
    } catch (error: unknown) {
      const err = error as { message?: string; stderr?: string }
      throw new Error(`npm ${args.script} failed: ${err.message}\n${err.stderr || ''}`)
    }
  },
})

// 导出所有 shell 工具
export const shellTools: Tool[] = [shellExecTool, shellStreamTool, npmTool]

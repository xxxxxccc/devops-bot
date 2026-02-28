/**
 * 工具注册中心
 * 集中管理所有工具，支持动态注册、策略过滤和执行
 */

import * as z from 'zod'
import { createLogger } from '../infra/logger.js'
import type { ToolPolicy } from './tool-policy.js'
import { filterTools } from './tool-policy.js'
import type { Tool, ToolContext } from './types.js'

const log = createLogger('registry')

/* ------------------------------------------------------------------ */
/*  Tool metrics                                                       */
/* ------------------------------------------------------------------ */

interface ToolMetricsEntry {
  calls: number
  errors: number
  totalDurationMs: number
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()
  private context: ToolContext
  private metrics: Map<string, ToolMetricsEntry> = new Map()

  constructor(projectPath: string) {
    this.context = {
      projectPath,
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Registration                                                     */
  /* ---------------------------------------------------------------- */

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      log.warn(`Tool "${tool.name}" is already registered, overwriting`)
    }
    this.tools.set(tool.name, tool)
    log.debug(`Registered tool: ${tool.name}`)
  }

  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Retrieval                                                        */
  /* ---------------------------------------------------------------- */

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values()).filter((t) => t.enabled !== false)
  }

  getByCategory(category: string): Tool[] {
    return this.getAll().filter((t) => t.category === category)
  }

  /**
   * Filter enabled tools through a ToolPolicy.
   * Supports allow/deny lists, category groups, and wildcards.
   */
  getFiltered(policy: ToolPolicy): Tool[] {
    return filterTools(this.getAll(), policy)
  }

  getNames(): string[] {
    return this.getAll().map((t) => t.name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /* ---------------------------------------------------------------- */
  /*  Execution                                                        */
  /* ---------------------------------------------------------------- */

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.get(name)
    if (!tool) {
      throw new Error(`Tool "${name}" not found`)
    }

    log.debug(`Executing: ${name}`, { args: JSON.stringify(args).slice(0, 100) })

    // Validate args against Zod schema before execution
    const validated = this.validateArgs(tool, args)

    const start = Date.now()
    try {
      const result = await tool.execute(validated, this.context)
      this.recordMetrics(name, Date.now() - start, false)
      log.debug(`Result from ${name}: ${result.length} chars`)
      return result
    } catch (error) {
      this.recordMetrics(name, Date.now() - start, true)
      const message = error instanceof Error ? error.message : String(error)
      log.error(`Error executing ${name}: ${message}`)
      throw error
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Validation                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Validate tool arguments against its Zod schema.
   * Returns the parsed (and potentially transformed) args.
   */
  private validateArgs(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
    try {
      const result = tool.schema.safeParse(args)
      if (!result.success) {
        const issues = (result.error as z.core.$ZodError).issues
          .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
          .join('\n')
        log.warn(`Validation warning for ${tool.name}:\n${issues}`)
        // Return original args — warn but don't block (AI may send extra fields)
        return args
      }
      return result.data as Record<string, unknown>
    } catch {
      // If schema validation itself throws, pass through
      return args
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Metrics                                                          */
  /* ---------------------------------------------------------------- */

  private recordMetrics(name: string, durationMs: number, isError: boolean): void {
    const entry = this.metrics.get(name) ?? { calls: 0, errors: 0, totalDurationMs: 0 }
    entry.calls++
    if (isError) entry.errors++
    entry.totalDurationMs += durationMs
    this.metrics.set(name, entry)
  }

  /**
   * Get usage metrics for all tools (or a specific tool).
   */
  getMetrics(name?: string): Record<string, ToolMetricsEntry> {
    if (name) {
      const entry = this.metrics.get(name)
      return entry ? { [name]: entry } : {}
    }
    return Object.fromEntries(this.metrics)
  }

  /**
   * Reset all metrics counters.
   */
  resetMetrics(): void {
    this.metrics.clear()
  }

  /* ---------------------------------------------------------------- */
  /*  Context                                                          */
  /* ---------------------------------------------------------------- */

  updateContext(updates: Partial<ToolContext>): void {
    this.context = { ...this.context, ...updates }
  }

  getContext(): ToolContext {
    return { ...this.context }
  }

  /* ---------------------------------------------------------------- */
  /*  Stats                                                            */
  /* ---------------------------------------------------------------- */

  clear(): void {
    this.tools.clear()
  }

  getStats(): { total: number; categories: Record<string, number> } {
    const tools = this.getAll()
    const categories: Record<string, number> = {}

    for (const tool of tools) {
      const cat = tool.category || 'uncategorized'
      categories[cat] = (categories[cat] || 0) + 1
    }

    return { total: tools.length, categories }
  }
}

let globalRegistry: ToolRegistry | null = null

export function createRegistry(projectPath: string): ToolRegistry {
  globalRegistry = new ToolRegistry(projectPath)
  return globalRegistry
}

export function getRegistry(): ToolRegistry {
  if (!globalRegistry) {
    throw new Error('Tool registry not initialized. Call createRegistry() first.')
  }
  return globalRegistry
}

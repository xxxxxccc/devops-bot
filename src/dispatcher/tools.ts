/**
 * Dispatcher Tools — read-only tools for project inspection.
 *
 * Uses the tool policy system to select which tools the dispatcher
 * can access (default: "read-only" profile = file-read + search groups).
 * Converts them to provider-neutral AIToolDefinition format via Zod 4's z.toJSONSchema().
 */

import * as z from 'zod'
import { fileTools } from '../tools/file-tools.js'
import { skillTools } from '../tools/skill-tools.js'
import type { Tool, ToolContext } from '../core/types.js'
import type { AIToolDefinition } from '../providers/types.js'
import { type ToolPolicy, filterTools, resolveProfile } from '../core/tool-policy.js'

/* ------------------------------------------------------------------ */
/*  Zod → AIToolDefinition converter                                   */
/* ------------------------------------------------------------------ */

function toAITool(tool: Tool): AIToolDefinition {
  const jsonSchema = z.toJSONSchema(tool.schema, { io: 'input' })
  const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object' as const, ...schema },
  }
}

/* ------------------------------------------------------------------ */
/*  Policy-driven tool selection                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_DISPATCHER_POLICY: ToolPolicy = resolveProfile('read-only')

const ALL_SOURCE_TOOLS: Tool[] = [...fileTools, ...skillTools]

/**
 * Get the filtered set of tools for the dispatcher, in provider-neutral format.
 */
export function getDispatcherTools(policy?: ToolPolicy): {
  tools: AIToolDefinition[]
  executors: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>>
} {
  const effectivePolicy = policy ?? DEFAULT_DISPATCHER_POLICY
  const filtered = filterTools(ALL_SOURCE_TOOLS, effectivePolicy)

  const tools = filtered.map(toAITool)
  const executors: Record<
    string,
    (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
  > = Object.fromEntries(
    filtered.map((t) => [
      t.name,
      (args: Record<string, unknown>, ctx: ToolContext) => t.execute(args, ctx),
    ]),
  )

  return { tools, executors }
}

/* ------------------------------------------------------------------ */
/*  Backward-compatible exports                                        */
/* ------------------------------------------------------------------ */

const { tools: DISPATCHER_TOOLS, executors: DISPATCHER_TOOL_EXECUTORS } = getDispatcherTools()

export { DISPATCHER_TOOLS, DISPATCHER_TOOL_EXECUTORS }

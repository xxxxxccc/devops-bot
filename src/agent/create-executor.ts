/**
 * Executor Factory
 *
 * Creates AIExecutor instances for different roles:
 * - dispatcher: fast model, single-turn, no tools (Layer 1)
 * - task: powerful model, multi-turn, full MCP tools (Layer 2)
 */

import type { AIExecutorOptions } from './ai-executor.js'
import { getModelRouter } from '../providers/router.js'

export type ExecutorRole = 'dispatcher' | 'task'

/**
 * Get executor configuration for a given role.
 * The caller is responsible for creating the AIExecutor instance.
 */
export async function getExecutorConfig(
  role: ExecutorRole,
  systemPrompt: string,
): Promise<AIExecutorOptions> {
  const router = getModelRouter()

  switch (role) {
    case 'dispatcher': {
      const spec = process.env.DISPATCHER_MODEL || 'claude-sonnet-4-5-20250929'
      const route = await router.resolve(spec)
      return {
        provider: route.provider,
        model: route.modelId,
        maxTokens: 4096,
        maxIterations: 1,
        systemPrompt,
      }
    }

    case 'task': {
      const spec = process.env.TASK_MODEL || 'claude-opus-4-5-20251101'
      const route = await router.resolve(spec)
      return {
        provider: route.provider,
        model: route.modelId,
        maxTokens: 16384,
        maxIterations: 100,
        systemPrompt,
      }
    }
  }
}

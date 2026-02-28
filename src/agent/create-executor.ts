/**
 * Executor Factory
 *
 * Creates AIExecutor instances for different roles:
 * - dispatcher: fast model, single-turn, no tools (Layer 1)
 * - task: powerful model, multi-turn, full MCP tools (Layer 2)
 */

import type { AIExecutorOptions } from './ai-executor.js'
import { createProviderFromEnv } from '../providers/index.js'

export type ExecutorRole = 'dispatcher' | 'task'

/**
 * Get executor configuration for a given role.
 * The caller is responsible for creating the AIExecutor instance.
 */
export async function getExecutorConfig(
  role: ExecutorRole,
  systemPrompt: string,
): Promise<AIExecutorOptions> {
  const provider = await createProviderFromEnv()

  switch (role) {
    case 'dispatcher':
      return {
        provider,
        model: process.env.DISPATCHER_MODEL || 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        maxIterations: 1,
        systemPrompt,
      }

    case 'task':
      return {
        provider,
        model: process.env.TASK_MODEL || 'claude-opus-4-5-20251101',
        maxTokens: 16384,
        maxIterations: 100,
        systemPrompt,
      }
  }
}

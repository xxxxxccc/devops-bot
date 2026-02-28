/**
 * AI Provider factory.
 *
 * Creates the appropriate provider based on configuration.
 * Supports backward-compatible env var fallbacks.
 */

import type { AIProvider, ProviderConfig, ProviderType } from './types.js'

export { type AIProvider, type ProviderType, type ProviderConfig } from './types.js'
export type {
  AIContentBlock,
  AIMessage,
  AIResponse,
  AIStopReason,
  AIToolDefinition,
  CreateMessageParams,
  AIImageMediaType,
} from './types.js'

/**
 * Create an AI provider from explicit config.
 */
export async function createProvider(config: ProviderConfig): Promise<AIProvider> {
  switch (config.type) {
    case 'anthropic': {
      const { AnthropicProvider } = await import('./anthropic.js')
      return new AnthropicProvider({ apiKey: config.apiKey, baseURL: config.baseURL })
    }
    case 'openai': {
      const { OpenAIProvider } = await import('./openai.js')
      return new OpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseURL })
    }
    default:
      throw new Error(`Unknown AI provider: ${config.type}`)
  }
}

/**
 * Resolve provider config from environment variables.
 *
 *   AI_PROVIDER  -> 'anthropic' (default)
 *   AI_API_KEY   -> required
 *   AI_BASE_URL  -> optional, for OpenAI-compatible endpoints
 */
export function resolveProviderConfig(): ProviderConfig {
  const type = (process.env.AI_PROVIDER || 'anthropic') as ProviderType
  const apiKey = process.env.AI_API_KEY
  if (!apiKey) {
    throw new Error('AI_API_KEY is not configured. Set it in .env.local')
  }
  return {
    type,
    apiKey,
    baseURL: process.env.AI_BASE_URL || undefined,
  }
}

/**
 * Convenience: create a provider directly from environment variables.
 */
export async function createProviderFromEnv(): Promise<AIProvider> {
  return createProvider(resolveProviderConfig())
}

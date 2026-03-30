/**
 * Model Router — resolves "provider/model" strings to the correct AIProvider + model ID.
 *
 * Supports:
 *   - "anthropic/claude-sonnet-4-5-20250929" → Anthropic provider + bare model ID
 *   - "openai/gpt-4.1" → OpenAI provider + bare model ID
 *   - "claude-sonnet-4-5-20250929" → fallback to AI_PROVIDER (backward compat)
 *
 * Per-provider API keys:
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL
 *   Falls back to AI_API_KEY if provider-specific key is not set.
 */

import { createLogger } from '../infra/logger.js'
import type { AIProvider, AIResponse, CreateMessageParams, ProviderType } from './types.js'

const log = createLogger('model-router')

export interface ModelRoute {
  provider: AIProvider
  modelId: string
}

const KNOWN_PROVIDERS = new Set<string>(['anthropic', 'openai'])

function parseModelSpec(spec: string): { providerName: string | null; modelId: string } {
  const slashIdx = spec.indexOf('/')
  if (slashIdx > 0) {
    const prefix = spec.slice(0, slashIdx).toLowerCase()
    if (KNOWN_PROVIDERS.has(prefix)) {
      return { providerName: prefix, modelId: spec.slice(slashIdx + 1) }
    }
  }
  return { providerName: null, modelId: spec }
}

function resolveProviderApiKey(providerName: string): { apiKey: string; baseURL?: string } {
  const upper = providerName.toUpperCase()
  const apiKey = process.env[`${upper}_API_KEY`] || process.env.AI_API_KEY
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${providerName}". Set ${upper}_API_KEY or AI_API_KEY.`,
    )
  }
  const baseURL = process.env[`${upper}_BASE_URL`] || undefined
  return { apiKey, baseURL }
}

export class ModelRouter {
  private providers = new Map<string, AIProvider>()

  /** Resolve a model spec to a provider instance + bare model ID. */
  async resolve(modelSpec: string): Promise<ModelRoute> {
    const { providerName, modelId } = parseModelSpec(modelSpec)
    const effectiveProvider = providerName || process.env.AI_PROVIDER || 'anthropic'

    const provider = await this.getOrCreateProvider(effectiveProvider)
    return { provider, modelId }
  }

  /** Convenience: resolve + call createMessage in one step. */
  async createMessage(
    modelSpec: string,
    params: Omit<CreateMessageParams, 'model'>,
  ): Promise<AIResponse> {
    const { provider, modelId } = await this.resolve(modelSpec)
    return provider.createMessage({ ...params, model: modelId })
  }

  private async getOrCreateProvider(name: string): Promise<AIProvider> {
    const existing = this.providers.get(name)
    if (existing) return existing

    const { apiKey, baseURL } = resolveProviderApiKey(name)
    const type = name as ProviderType

    let provider: AIProvider
    switch (type) {
      case 'anthropic': {
        const { AnthropicProvider } = await import('./anthropic.js')
        provider = new AnthropicProvider({ apiKey, baseURL })
        break
      }
      case 'openai': {
        const { OpenAIProvider } = await import('./openai.js')
        provider = new OpenAIProvider({ apiKey, baseURL })
        break
      }
      default:
        throw new Error(`Unknown AI provider: ${name}`)
    }

    this.providers.set(name, provider)
    log.info(`Provider initialized: ${name}`, { hasBaseURL: !!baseURL })
    return provider
  }
}

let _router: ModelRouter | null = null

/** Singleton model router. */
export function getModelRouter(): ModelRouter {
  if (!_router) {
    _router = new ModelRouter()
  }
  return _router
}

/**
 * Provider-agnostic AI types.
 *
 * All executor and dispatcher code operates on these neutral types.
 * Concrete adapters (Anthropic, OpenAI) map to/from vendor SDK types.
 */

/* ------------------------------------------------------------------ */
/*  Content blocks                                                     */
/* ------------------------------------------------------------------ */

export type AIImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export type AIContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; data: string; mediaType: AIImageMediaType }
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      toolUseId: string
      content: string
      isError?: boolean
    }

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | AIContentBlock[]
}

/* ------------------------------------------------------------------ */
/*  Tools                                                              */
/* ------------------------------------------------------------------ */

export interface AIToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  Response                                                           */
/* ------------------------------------------------------------------ */

export type AIStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

export interface AIResponse {
  content: AIContentBlock[]
  stopReason: AIStopReason
  usage?: { inputTokens: number; outputTokens: number }
}

/* ------------------------------------------------------------------ */
/*  Provider interface                                                 */
/* ------------------------------------------------------------------ */

export interface CreateMessageParams {
  model: string
  system?: string
  messages: AIMessage[]
  tools?: AIToolDefinition[]
  maxTokens: number
  temperature?: number
}

export interface AIProvider {
  createMessage(params: CreateMessageParams): Promise<AIResponse>
}

/* ------------------------------------------------------------------ */
/*  Provider config                                                    */
/* ------------------------------------------------------------------ */

export type ProviderType = 'anthropic' | 'openai'

export interface ProviderConfig {
  type: ProviderType
  apiKey: string
  baseURL?: string
}

/**
 * OpenAI provider adapter.
 *
 * Maps our neutral AI types to/from the OpenAI chat completions API.
 * Also works with OpenAI-compatible endpoints (DeepSeek, Groq, Together, etc.)
 * by setting a custom baseURL.
 */

import OpenAI from 'openai'
import type {
  AIContentBlock,
  AIMessage,
  AIProvider,
  AIResponse,
  AIStopReason,
  AIToolDefinition,
  CreateMessageParams,
} from './types.js'

export class OpenAIProvider implements AIProvider {
  private client: OpenAI

  constructor(options: { apiKey: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    })
  }

  async createMessage(params: CreateMessageParams): Promise<AIResponse> {
    const messages = toOpenAIMessages(params.system, params.messages)

    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools.map(toOpenAITool) } : {}),
    })

    return fromOpenAIResponse(response)
  }
}

/* ------------------------------------------------------------------ */
/*  To OpenAI format                                                   */
/* ------------------------------------------------------------------ */

function toOpenAIMessages(
  system: string | undefined,
  messages: AIMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = []

  if (system) {
    result.push({ role: 'system', content: system })
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })
      continue
    }

    // Separate tool_result blocks (they become standalone 'tool' messages in OpenAI)
    const toolResults = msg.content.filter((b) => b.type === 'tool_result')
    const otherBlocks = msg.content.filter((b) => b.type !== 'tool_result')

    if (msg.role === 'user' && toolResults.length > 0) {
      for (const tr of toolResults) {
        if (tr.type !== 'tool_result') continue
        result.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const textParts = otherBlocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')

      const toolUseBlocks = otherBlocks.filter((b) => b.type === 'tool_use')

      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        ...(textParts ? { content: textParts } : {}),
      }

      if (toolUseBlocks.length > 0) {
        assistantMsg.tool_calls = toolUseBlocks.map((b) => {
          if (b.type !== 'tool_use') throw new Error('unreachable')
          return {
            id: b.id,
            type: 'function' as const,
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          }
        })
      }

      result.push(assistantMsg)
      continue
    }

    // User message with mixed content (text + images)
    const parts: OpenAI.ChatCompletionContentPart[] = []
    for (const block of otherBlocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.mediaType};base64,${block.source.data}`,
          },
        })
      }
    }
    if (parts.length > 0) {
      result.push({ role: 'user', content: parts })
    }
  }

  return result
}

function toOpenAITool(tool: AIToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

/* ------------------------------------------------------------------ */
/*  From OpenAI format                                                 */
/* ------------------------------------------------------------------ */

function fromOpenAIResponse(response: OpenAI.ChatCompletion): AIResponse {
  const choice = response.choices[0]
  if (!choice) {
    return { content: [], stopReason: 'end_turn' }
  }

  const content: AIContentBlock[] = []
  const msg = choice.message

  if (msg.content) {
    content.push({ type: 'text', text: msg.content })
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = { _raw: tc.function.arguments }
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  const stopReasonMap: Record<string, AIStopReason> = {
    stop: 'end_turn',
    tool_calls: 'tool_use',
    length: 'max_tokens',
    content_filter: 'end_turn',
  }

  return {
    content,
    stopReason: stopReasonMap[choice.finish_reason ?? 'stop'] ?? 'end_turn',
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens ?? 0,
        }
      : undefined,
  }
}

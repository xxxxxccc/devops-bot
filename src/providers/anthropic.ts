/**
 * Anthropic provider adapter.
 *
 * Maps our neutral AI types to/from the @anthropic-ai/sdk types.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  AIContentBlock,
  AIMessage,
  AIProvider,
  AIResponse,
  AIStopReason,
  AIToolDefinition,
  CreateMessageParams,
} from './types.js'

export class AnthropicProvider implements AIProvider {
  private client: Anthropic

  constructor(options: { apiKey: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    })
  }

  async createMessage(params: CreateMessageParams): Promise<AIResponse> {
    const messages = params.messages.map(toAnthropicMessage)

    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    }

    if (params.system) {
      requestParams.system = [
        { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } },
      ]
    }

    if (params.tools && params.tools.length > 0) {
      requestParams.tools = params.tools.map(toAnthropicTool)
    }

    const response = await this.client.messages.create(requestParams)
    return fromAnthropicResponse(response)
  }
}

/* ------------------------------------------------------------------ */
/*  Type conversion helpers                                            */
/* ------------------------------------------------------------------ */

function toAnthropicMessage(msg: AIMessage): Anthropic.MessageParam {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content }
  }

  const blocks: Anthropic.ContentBlockParam[] = msg.content.map(toAnthropicContentBlock)
  return { role: msg.role, content: blocks }
}

function toAnthropicContentBlock(block: AIContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.source.mediaType,
          data: block.source.data,
        },
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      }
  }
}

function toAnthropicTool(tool: AIToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object' as const, ...tool.inputSchema },
  }
}

function fromAnthropicResponse(response: Anthropic.Message): AIResponse {
  const content: AIContentBlock[] = response.content.map(fromAnthropicContentBlock)

  const stopReasonMap: Record<string, AIStopReason> = {
    end_turn: 'end_turn',
    tool_use: 'tool_use',
    max_tokens: 'max_tokens',
    stop_sequence: 'end_turn',
  }

  return {
    content,
    stopReason: stopReasonMap[response.stop_reason ?? 'end_turn'] ?? 'end_turn',
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : undefined,
  }
}

function fromAnthropicContentBlock(block: Anthropic.ContentBlock): AIContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }
    default:
      return { type: 'text', text: JSON.stringify(block) }
  }
}

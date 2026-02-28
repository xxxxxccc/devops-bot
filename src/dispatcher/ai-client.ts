/**
 * Dispatcher AI Client — handles AI API interaction (provider-agnostic).
 *
 * Responsibilities:
 * - Build multimodal message content (text + images)
 * - Run the tool-use loop until the model produces a final answer
 * - Parse JSON from the model's response (with retry)
 * - Write debug logs for troubleshooting
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Attachment } from '../channels/types.js'
import type { ToolContext } from '../core/types.js'
import type { AIContentBlock, AIMessage, AIProvider } from '../providers/types.js'
import { createProviderFromEnv } from '../providers/index.js'
import { retry } from '../infra/retry.js'
import { createLogger } from '../infra/logger.js'
import { DISPATCHER_TOOLS, DISPATCHER_TOOL_EXECUTORS } from './tools.js'

const log = createLogger('dispatcher')

const DISPATCHER_MODEL = process.env.DISPATCHER_MODEL || 'claude-sonnet-4-5-20250929'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DispatcherResponse {
  intent: 'chat' | 'query_memory' | 'create_task'
  reply?: string
  taskTitle?: string
  taskDescription?: string
}

/* ------------------------------------------------------------------ */
/*  Client                                                             */
/* ------------------------------------------------------------------ */

export class DispatcherAIClient {
  private provider: AIProvider | null = null

  private readonly debugLogPath: string

  constructor() {
    const dataDir = join(homedir(), '.devops-bot', 'data')
    mkdirSync(dataDir, { recursive: true })
    this.debugLogPath = join(dataDir, 'dispatcher-debug.jsonl')
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  async call(
    userPrompt: string,
    attachments: Attachment[],
    projectPath: string,
    systemPrompt: string,
    onProgress?: (info: { round: number; toolName: string }) => void,
  ): Promise<DispatcherResponse> {
    const provider = await this.getProvider()
    const content = this.buildMessageContent(userPrompt, attachments)
    const toolContext: ToolContext = { projectPath }

    const messages: AIMessage[] = [{ role: 'user', content }]

    let round = 0
    const toolHistory: ToolHistoryEntry[] = []

    while (true) {
      round++
      const response = await retry(
        () =>
          provider.createMessage({
            model: DISPATCHER_MODEL,
            maxTokens: 4096,
            system: systemPrompt,
            messages,
            tools: DISPATCHER_TOOLS,
          }),
        {
          maxAttempts: 3,
          onRetry: (err, attempt, delay) =>
            log.warn(`AI API retry ${attempt}`, {
              delay,
              error: err instanceof Error ? err.message : String(err),
            }),
        },
      )

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')

      const contentSummary = response.content.map((b) => {
        if (b.type === 'text') return { type: 'text', length: b.text.length }
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, id: b.id }
        return { type: b.type }
      })

      // Truncated text-only response — retry for JSON
      if (response.stopReason === 'max_tokens' && toolUseBlocks.length === 0 && round <= 3) {
        const truncatedText = extractText(response.content)

        log.warn(`Response truncated (max_tokens) at round ${round}, asking for JSON-only retry`)

        const partial = extractJSON(truncatedText)
        if (partial) return partial

        messages.push({ role: 'assistant', content: truncatedText })
        messages.push({
          role: 'user',
          content:
            'Your response was truncated because it was too long. ' +
            'Please respond with ONLY the JSON object — no explanation, no markdown fences, no prose. ' +
            'Keep taskDescription under 500 characters. Output ONLY: {"intent": "...", ...}',
        })
        continue
      }

      if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
        return this.handleFinalResponse(
          response.content,
          response.stopReason,
          response.usage,
          contentSummary,
          round,
          toolHistory,
          provider,
          messages,
          systemPrompt,
        )
      }

      // Execute tool calls and feed results back
      messages.push({ role: 'assistant', content: response.content })
      const toolResults = await this.executeTools(toolUseBlocks, toolContext, toolHistory, round)
      messages.push({ role: 'user', content: toolResults })

      if (toolUseBlocks.length > 0 && toolUseBlocks[0].type === 'tool_use') {
        onProgress?.({ round, toolName: toolUseBlocks[0].name })
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Tool execution                                                   */
  /* ---------------------------------------------------------------- */

  private async executeTools(
    toolUseBlocks: AIContentBlock[],
    toolContext: ToolContext,
    toolHistory: ToolHistoryEntry[],
    round: number,
  ): Promise<AIContentBlock[]> {
    const results: AIContentBlock[] = []

    for (const toolUse of toolUseBlocks) {
      if (toolUse.type !== 'tool_use') continue

      const executor = DISPATCHER_TOOL_EXECUTORS[toolUse.name]
      if (!executor) {
        toolHistory.push({
          round,
          tool: toolUse.name,
          input: toolUse.input,
          resultLength: 0,
          error: 'unknown tool',
        })
        results.push({
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          isError: true,
        })
        continue
      }

      try {
        const result = await executor(toolUse.input as Record<string, unknown>, toolContext)
        const truncated =
          result.length > 8000
            ? `${result.slice(0, 8000)}\n... (truncated, ${result.length} chars total)`
            : result
        toolHistory.push({
          round,
          tool: toolUse.name,
          input: toolUse.input,
          resultLength: result.length,
        })
        results.push({ type: 'tool_result', toolUseId: toolUse.id, content: truncated })
        log.info(`Tool ${toolUse.name} (round ${round}): ${result.length} chars`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        toolHistory.push({
          round,
          tool: toolUse.name,
          input: toolUse.input,
          resultLength: 0,
          error: msg,
        })
        results.push({
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: `Error: ${msg}`,
          isError: true,
        })
        log.warn(`Tool ${toolUse.name} error: ${msg}`)
      }
    }

    return results
  }

  /* ---------------------------------------------------------------- */
  /*  Response handling                                                */
  /* ---------------------------------------------------------------- */

  private async handleFinalResponse(
    content: AIContentBlock[],
    stopReason: string,
    usage: { inputTokens: number; outputTokens: number } | undefined,
    contentSummary: unknown[],
    round: number,
    toolHistory: ToolHistoryEntry[],
    provider: AIProvider,
    messages: AIMessage[],
    systemPrompt: string,
  ): Promise<DispatcherResponse> {
    const text = extractText(content)

    if (round > 1) {
      log.info(`Completed after ${round} rounds`)
    }

    const parsed = extractJSON(text)
    if (parsed) {
      this.debugLog('dispatch_success', {
        round,
        intent: parsed.intent,
        stop_reason: stopReason,
        usage,
        toolHistory,
      })
      return parsed
    }

    this.debugLog('json_parse_failed', {
      round,
      stop_reason: stopReason,
      content_blocks: contentSummary,
      raw_text: text,
      usage,
      toolHistory,
    })
    log.warn(`JSON parse failed (round ${round}, stop_reason=${stopReason})`)

    return this.retryJsonParse(provider, messages, text, systemPrompt)
  }

  private async retryJsonParse(
    provider: AIProvider,
    messages: AIMessage[],
    originalText: string,
    systemPrompt: string,
  ): Promise<DispatcherResponse> {
    messages.push({ role: 'assistant', content: originalText })
    messages.push({
      role: 'user',
      content:
        'Your previous response was not valid JSON. Please respond with ONLY the JSON object, no other text:\n{"intent": "...", "reply": "...", ...}',
    })

    const retryResponse = await retry(
      () =>
        provider.createMessage({
          model: DISPATCHER_MODEL,
          maxTokens: 4096,
          system: systemPrompt,
          messages,
        }),
      {
        maxAttempts: 2,
        onRetry: (err, attempt, delay) =>
          log.warn(`AI JSON-retry API retry ${attempt}`, {
            delay,
            error: err instanceof Error ? err.message : String(err),
          }),
      },
    )

    const retryText = extractText(retryResponse.content)

    const retryParsed = extractJSON(retryText)
    if (retryParsed) {
      this.debugLog('json_retry_success', { intent: retryParsed.intent, retry_text: retryText })
      return retryParsed
    }

    this.debugLog('json_retry_failed', {
      retry_raw_text: retryText,
      retry_stop_reason: retryResponse.stopReason,
      retry_usage: retryResponse.usage,
    })
    log.warn('Retry also failed, falling back to raw text')
    const fallback = originalText.length > 500 ? `${originalText.slice(0, 500)}...` : originalText
    return { intent: 'chat', reply: fallback || '抱歉，我故障了' }
  }

  /* ---------------------------------------------------------------- */
  /*  Multimodal content                                               */
  /* ---------------------------------------------------------------- */

  private buildMessageContent(
    userPrompt: string,
    attachments: Attachment[],
  ): string | AIContentBlock[] {
    const imageAttachments = attachments.filter(
      (a) => a.mimetype.startsWith('image/') && existsSync(a.path),
    )

    if (imageAttachments.length === 0) return userPrompt

    const blocks: AIContentBlock[] = []
    for (const att of imageAttachments) {
      try {
        const buf = readFileSync(att.path)
        const mediaType = detectImageMediaType(buf)
        if (!mediaType) {
          log.warn(`Unknown image format for ${att.path}, skipping`)
          continue
        }
        blocks.push({
          type: 'image',
          source: { type: 'base64', mediaType, data: buf.toString('base64') },
        })
        log.info(`Attached image: ${att.originalname} (${mediaType})`)
      } catch (err) {
        log.warn(`Failed to read image ${att.path}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    blocks.push({ type: 'text', text: userPrompt })
    return blocks
  }

  /* ---------------------------------------------------------------- */
  /*  Internals                                                        */
  /* ---------------------------------------------------------------- */

  private async getProvider(): Promise<AIProvider> {
    if (!this.provider) {
      this.provider = await createProviderFromEnv()
    }
    return this.provider
  }

  private debugLog(event: string, data: Record<string, unknown>): void {
    const entry = { timestamp: new Date().toISOString(), event, ...data }
    try {
      appendFileSync(this.debugLogPath, `${JSON.stringify(entry)}\n`)
    } catch {
      // Don't crash on log failure
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Pure utility functions (exported for testing)                      */
/* ------------------------------------------------------------------ */

interface ToolHistoryEntry {
  round: number
  tool: string
  input: unknown
  resultLength: number
  error?: string
}

function extractText(content: AIContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
}

/**
 * Detect actual image media type from file magic bytes.
 */
export function detectImageMediaType(
  buf: Buffer,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * Try to extract a JSON object from AI response text.
 */
export function extractJSON(text: string): DispatcherResponse | null {
  try {
    return JSON.parse(text.trim()) as DispatcherResponse
  } catch {
    // continue
  }

  const fenceOpenRegex = /```(?:json)?\s*\n/g
  let fenceOpen: RegExpExecArray | null
  while ((fenceOpen = fenceOpenRegex.exec(text)) !== null) {
    const contentStart = fenceOpen.index + fenceOpen[0].length
    for (let end = text.length - 1; end >= contentStart; end--) {
      if (text[end] === '`' && text[end - 1] === '`' && text[end - 2] === '`') {
        const fenced = text.slice(contentStart, end - 2).trim()
        if (fenced.startsWith('{') && fenced.includes('"intent"')) {
          try {
            return JSON.parse(fenced) as DispatcherResponse
          } catch {
            // continue
          }
        }
        break
      }
    }
  }

  const stripped = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
  if (stripped.startsWith('{')) {
    try {
      return JSON.parse(stripped) as DispatcherResponse
    } catch {
      // continue
    }
  }

  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '}') continue
    const candidate = findBalancedJSON(text, i)
    if (candidate && candidate.includes('"intent"')) {
      try {
        return JSON.parse(candidate) as DispatcherResponse
      } catch {
        // continue
      }
    }
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as DispatcherResponse
    } catch {
      // continue
    }
  }

  if (text.includes('"intent"')) {
    const intentMatch = text.match(/"intent"\s*:\s*"(chat|query_memory|create_task)"/)
    if (intentMatch) {
      const intent = intentMatch[1] as DispatcherResponse['intent']
      const replyMatch = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/)
      const titleMatch = text.match(/"taskTitle"\s*:\s*"((?:[^"\\]|\\.)*)/)
      const descMatch = text.match(/"taskDescription"\s*:\s*"((?:[^"\\]|\\.)*)/)

      if (intent === 'create_task' && titleMatch) {
        return {
          intent,
          taskTitle: unescapeJSON(titleMatch[1]),
          taskDescription: descMatch ? unescapeJSON(descMatch[1]) : undefined,
        }
      }
      if (replyMatch) {
        return { intent, reply: unescapeJSON(replyMatch[1]) }
      }
    }
  }

  const trimmed = text.trim()
  if (trimmed.length > 20 && !trimmed.includes('"intent"')) {
    return { intent: 'chat', reply: trimmed }
  }

  return null
}

function unescapeJSON(s: string): string {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
  }
}

export function findBalancedJSON(text: string, closeIndex: number): string | null {
  let depth = 0
  let inString = false

  for (let i = closeIndex; i >= 0; i--) {
    const ch = text[i]

    if (ch === '"') {
      let backslashes = 0
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) {
        backslashes++
      }
      if (backslashes % 2 === 0) {
        inString = !inString
      }
      continue
    }

    if (inString) continue

    if (ch === '}') depth++
    else if (ch === '{') {
      depth--
      if (depth === 0) return text.slice(i, closeIndex + 1)
    }
  }
  return null
}

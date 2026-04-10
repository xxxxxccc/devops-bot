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
import { getModelRouter } from '../providers/router.js'
import { retry } from '../infra/retry.js'
import { createLogger } from '../infra/logger.js'
import { DISPATCHER_TOOLS, DISPATCHER_TOOL_EXECUTORS } from './tools.js'

const log = createLogger('dispatcher')

const DISPATCHER_MODEL = process.env.DISPATCHER_MODEL || 'claude-sonnet-4-5-20250929'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DispatcherResponse {
  intent:
    | 'chat'
    | 'query_memory'
    | 'execute_task'
    | 'propose_task'
    | 'create_issue'
    | 'add_project'
    | 'remove_project'
    | 'review_pr'
    | 'add_workspace'
    | 'remove_workspace'
  reply?: string
  projectId?: string
  taskTitle?: string
  taskDescription?: string
  /** Why this risk tier was chosen (shown in Issue + chat reply) */
  riskReason?: string
  /** Labels for issues (e.g. ["enhancement", "bug"]) */
  issueLabels?: string[]
  /** Git URL for add_project or add_workspace intent */
  gitUrl?: string
  /** Git URL of the target sub-project (workspace mode) */
  targetGitUrl?: string
  /** Target branch override (from workspace manifest) */
  targetBranch?: string
  /** PR number for review_pr intent */
  prNumber?: number
  /** Detected language of the user message (e.g. "zh-CN", "en") */
  language?: string
}

/* ------------------------------------------------------------------ */
/*  Client                                                             */
/* ------------------------------------------------------------------ */

export class DispatcherAIClient {
  private provider: AIProvider | null = null
  private resolvedModel: string = DISPATCHER_MODEL

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
            model: this.resolvedModel,
            maxTokens: 8192,
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

        log.warn(`Response truncated (max_tokens) at round ${round}`)

        const partial = extractJSON(truncatedText)

        if (
          partial &&
          (partial.intent === 'chat' || partial.intent === 'query_memory') &&
          partial.reply
        ) {
          const continued = await this.continueChatReply(provider, partial.reply)
          if (continued) partial.reply += continued
          return partial
        }

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
  /*  Truncation recovery                                              */
  /* ---------------------------------------------------------------- */

  private async continueChatReply(
    provider: AIProvider,
    partialReply: string,
  ): Promise<string | null> {
    try {
      const tail = partialReply.slice(-800)
      const contResponse = await provider.createMessage({
        model: this.resolvedModel,
        maxTokens: 4096,
        system:
          'You are continuing a response that was cut off mid-sentence. ' +
          'Output ONLY the remaining text — no preamble, no JSON, no code fences.',
        messages: [
          {
            role: 'user',
            content: `The reply was cut off here:\n\n…${tail}\n\nContinue from where it stopped.`,
          },
        ],
      })
      const text = extractText(contResponse.content)
      if (text && text.trim().length > 5) {
        log.info(`Continued truncated chat reply (+${text.trim().length} chars)`)
        return text.trim()
      }
    } catch (err) {
      log.warn('Failed to continue truncated chat reply', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return null
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
    const jsonDiagnostics = inspectJSONLikeText(text)

    log.info('AI final response received', {
      round,
      stopReason,
      textLength: text.length,
      previewStart: previewText(text, 'start'),
      previewEnd: previewText(text, 'end'),
      ...jsonDiagnostics,
    })

    if (round > 1) {
      log.info(`Completed after ${round} rounds`)
    }

    const parsed = extractJSON(text)
    if (parsed) {
      log.info('AI final response parsed', summarizeDispatcherResponse(parsed))
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
      json_diagnostics: jsonDiagnostics,
      usage,
      toolHistory,
    })
    log.warn(`JSON parse failed (round ${round}, stop_reason=${stopReason})`, {
      textLength: text.length,
      previewStart: previewText(text, 'start'),
      previewEnd: previewText(text, 'end'),
      ...jsonDiagnostics,
    })

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
        'Your previous response was not valid JSON. ' +
        'Respond with ONLY the JSON object, with no prose before or after it. ' +
        'IMPORTANT: every string value must be valid JSON. ' +
        'If `reply` contains double quotes, escape them as `\\"` or use Chinese quotes like `「」` instead. ' +
        'Output ONLY: {"intent": "...", "reply": "...", ...}',
    })

    const retryResponse = await retry(
      () =>
        provider.createMessage({
          model: this.resolvedModel,
          maxTokens: 8192,
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
    const retryDiagnostics = inspectJSONLikeText(retryText)

    log.info('AI JSON retry response received', {
      stopReason: retryResponse.stopReason,
      textLength: retryText.length,
      previewStart: previewText(retryText, 'start'),
      previewEnd: previewText(retryText, 'end'),
      ...retryDiagnostics,
    })

    const retryParsed = extractJSON(retryText)
    if (retryParsed) {
      log.info('AI JSON retry parsed', summarizeDispatcherResponse(retryParsed))
      this.debugLog('json_retry_success', { intent: retryParsed.intent, retry_text: retryText })
      return retryParsed
    }

    this.debugLog('json_retry_failed', {
      retry_raw_text: retryText,
      retry_stop_reason: retryResponse.stopReason,
      retry_usage: retryResponse.usage,
    })
    log.warn('Retry also failed, falling back to raw text', {
      originalTextLength: originalText.length,
      retryTextLength: retryText.length,
      originalPreviewEnd: previewText(originalText, 'end'),
      retryPreviewEnd: previewText(retryText, 'end'),
      ...retryDiagnostics,
    })
    if (looksLikeBrokenDispatcherJSON(originalText) || looksLikeBrokenDispatcherJSON(retryText)) {
      return {
        intent: 'chat',
        reply:
          'I hit a reply formatting error while generating the response. Please ask me to try again.',
      }
    }
    const fallback = originalText.length > 500 ? `${originalText.slice(0, 500)}...` : originalText
    return { intent: 'chat', reply: fallback || 'Sorry, something went wrong.' }
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
      const route = await getModelRouter().resolve(DISPATCHER_MODEL)
      this.provider = route.provider
      this.resolvedModel = route.modelId
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
    const intentMatch = text.match(
      /"intent"\s*:\s*"(chat|query_memory|execute_task|propose_task|create_issue|add_project|remove_project|review_pr|add_workspace|remove_workspace)"/,
    )
    if (intentMatch) {
      const intent = intentMatch[1] as DispatcherResponse['intent']
      const replyValue =
        extractJSONFieldValue(text, 'reply') ||
        extractMalformedStringFieldValue(text, 'reply', true)
      const titleValue =
        extractJSONFieldValue(text, 'taskTitle') ||
        extractMalformedStringFieldValue(text, 'taskTitle', true)
      const descValue =
        extractJSONFieldValue(text, 'taskDescription') ||
        extractMalformedStringFieldValue(text, 'taskDescription', true)
      const projectIdValue = extractJSONFieldValue(text, 'projectId')

      if (
        (intent === 'execute_task' || intent === 'propose_task' || intent === 'create_issue') &&
        titleValue
      ) {
        return {
          intent,
          projectId: projectIdValue ? unescapeJSON(projectIdValue) : undefined,
          taskTitle: unescapeJSON(titleValue),
          taskDescription: descValue ? unescapeJSON(descValue) : undefined,
        }
      }
      if (replyValue) {
        return {
          intent,
          reply: unescapeJSON(replyValue),
          projectId: projectIdValue ? unescapeJSON(projectIdValue) : undefined,
        }
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

function extractJSONFieldValue(text: string, key: string): string | null {
  const match = text.match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*(?=,|}|$)`),
  )
  return match?.[1] || null
}

function inspectJSONLikeText(text: string): Record<string, boolean> {
  return {
    hasIntent: text.includes('"intent"'),
    hasReplyKey: text.includes('"reply"'),
    hasCompleteReply: extractJSONFieldValue(text, 'reply') !== null,
    hasRecoverableReply:
      extractJSONFieldValue(text, 'reply') === null &&
      extractMalformedStringFieldValue(text, 'reply') !== null,
    hasTaskTitleKey: text.includes('"taskTitle"'),
    hasCompleteTaskTitle: extractJSONFieldValue(text, 'taskTitle') !== null,
  }
}

function looksLikeBrokenDispatcherJSON(text: string): boolean {
  const diagnostics = inspectJSONLikeText(text)
  return (
    diagnostics.hasIntent &&
    ((diagnostics.hasReplyKey && !diagnostics.hasCompleteReply) ||
      (diagnostics.hasTaskTitleKey && !diagnostics.hasCompleteTaskTitle))
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractMalformedStringFieldValue(
  text: string,
  key: string,
  logRecovery = false,
): string | null {
  const keyMatch = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`).exec(text)
  if (!keyMatch) return null

  const valueStart = keyMatch.index + keyMatch[0].length
  const valueEnd = findMalformedStringFieldEnd(text, valueStart, key)
  if (valueEnd === -1) return null

  const rawValue = text.slice(valueStart, valueEnd)
  const normalizedValue = rawValue.trim()
  if (!normalizedValue) return null

  if (logRecovery) {
    log.warn('Recovered malformed JSON field', {
      field: key,
      recoveredLength: normalizedValue.length,
      previewStart: previewText(normalizedValue, 'start'),
      previewEnd: previewText(normalizedValue, 'end'),
    })
  }

  return normalizedValue
}

function findMalformedStringFieldEnd(text: string, valueStart: number, currentKey: string): number {
  const otherKeys = DISPATCHER_RESPONSE_KEYS.filter((key) => key !== currentKey)
  const markers = [...otherKeys.map((key) => `","${key}"`), '"}']

  let bestIndex = -1
  for (const marker of markers) {
    const index = text.indexOf(marker, valueStart)
    if (index === -1) continue
    if (bestIndex === -1 || index < bestIndex) {
      bestIndex = index
    }
  }

  return bestIndex
}

function previewText(
  value: string | undefined,
  side: 'start' | 'end',
  maxChars = 120,
): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return side === 'start' ? `${normalized.slice(0, maxChars)}…` : `…${normalized.slice(-maxChars)}`
}

function summarizeDispatcherResponse(
  response: DispatcherResponse,
): Record<string, string | number | undefined> {
  return {
    intent: response.intent,
    projectId: response.projectId,
    prNumber: response.prNumber,
    replyLength: response.reply?.length,
    replyPreviewStart: previewText(response.reply, 'start'),
    replyPreviewEnd: previewText(response.reply, 'end'),
    taskTitle: response.taskTitle,
    taskDescriptionLength: response.taskDescription?.length,
  }
}

const DISPATCHER_RESPONSE_KEYS = [
  'intent',
  'projectId',
  'reply',
  'taskTitle',
  'taskDescription',
  'riskReason',
  'issueLabels',
  'gitUrl',
  'targetGitUrl',
  'targetBranch',
  'prNumber',
  'language',
] as const

/**
 * Memory Extractor
 *
 * Three extraction sources:
 * A. Conversation memory - AI-powered extraction after N messages
 * B. Task input - Direct storage on task creation
 * C. Task result - Direct storage + AI extraction on task completion
 *
 * Deduplication is handled automatically by MemoryStore.addItem(),
 * which calls deduplicateOrReinforce() internally.
 */

import type { AIProvider } from '../providers/types.js'
import { createProviderFromEnv } from '../providers/index.js'
import { createLogger } from '../infra/logger.js'
import type { Task } from '../core/types.js'
import type { MemoryStore } from './store.js'
import type { ConversationRecord, MemoryItem } from './types.js'

const log = createLogger('extractor')

const EXTRACT_THRESHOLD = parseInt(process.env.MEMORY_EXTRACT_THRESHOLD || '5', 10)
const MEMORY_MODEL = process.env.MEMORY_MODEL || 'claude-haiku-4-5-20251001'

function stripFences(text: string): string {
  return text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
}

export class MemoryExtractor {
  private provider: AIProvider | null = null

  constructor(private store: MemoryStore) {}

  private async getProvider(): Promise<AIProvider> {
    if (!this.provider) {
      this.provider = await createProviderFromEnv()
    }
    return this.provider
  }

  // ========================
  // A. Conversation Memory Extraction
  // ========================

  async maybeExtractFromConversation(conversation: ConversationRecord): Promise<void> {
    const unextracted = conversation.messages.length - conversation.extractedUpTo
    if (unextracted < EXTRACT_THRESHOLD) return

    log.info(
      `Extracting memories from conversation ${conversation.date} (${unextracted} new messages)`,
    )

    try {
      const items = await this.extractFromConversation(conversation)
      if (items.length > 0) {
        this.store.addItems(items)
        log.info(`Extracted ${items.length} memories from conversation`)
      }
      this.store.updateExtractedUpTo(conversation.key, conversation.messages.length)
    } catch (err) {
      log.error('Failed to extract from conversation', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async extractFromConversation(conversation: ConversationRecord): Promise<MemoryItem[]> {
    const newMessages = conversation.messages.slice(conversation.extractedUpTo)
    if (newMessages.length === 0) return []

    const messagesText = newMessages
      .map((m) => `${m.senderName || m.role}: ${m.content}`)
      .join('\n')

    const prompt = `Analyze the following conversation and extract important facts.
Return a JSON array of objects with fields: type, content.

Types:
- "decision": Technical decisions made (what was chosen, why)
- "context": Project context learned (architecture, conventions)
- "preference": User preferences discovered (code style, tools)
- "issue": Problems or issues mentioned (bugs, tech debt)

Only extract genuinely important and specific information. Skip greetings, acknowledgments, and generic statements.
If nothing worth remembering, return an empty array [].

Conversation:
${messagesText}

Respond with ONLY a valid JSON array, no markdown fences:`

    try {
      const provider = await this.getProvider()
      const response = await provider.createMessage({
        model: MEMORY_MODEL,
        maxTokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')

      const extracted = JSON.parse(stripFences(text)) as Array<{ type: string; content: string }>
      const now = new Date().toISOString()

      return extracted.map((e) => ({
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: e.type as MemoryItem['type'],
        content: e.content,
        source: 'conversation' as const,
        sourceId: conversation.id,
        projectPath: conversation.projectPath,
        createdAt: now,
      }))
    } catch (err) {
      log.error('AI extraction failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  // ========================
  // B. Task Input Memory
  // ========================

  memorizeTaskInput(task: Task, projectPath: string): void {
    this.store.addItem({
      type: 'task_input',
      content: `[${task.createdBy || 'unknown'}] ${task.prompt.slice(0, 500)}`,
      source: 'task',
      sourceId: task.id,
      projectPath,
      createdBy: task.createdBy,
    })
  }

  // ========================
  // C. Task Result Memory
  // ========================

  async memorizeTaskResult(task: Task, projectPath: string): Promise<void> {
    if (!task.summary) return

    this.store.addItem({
      type: 'task_result',
      content: [
        task.summary.thinking,
        task.summary.modifiedFiles?.length
          ? `Modified files: ${task.summary.modifiedFiles.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      source: 'task',
      sourceId: task.id,
      projectPath,
      createdBy: task.createdBy,
    })

    if (task.summary.thinking) {
      try {
        const items = await this.extractFromText(task.summary.thinking, task.id, projectPath)
        if (items.length > 0) {
          this.store.addItems(items)
          log.info(`Extracted ${items.length} memories from task result`)
        }
      } catch (err) {
        log.error('Failed to extract from task result', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  memorizeTaskFailure(task: Task, projectPath: string): void {
    if (!task.error) return
    this.store.addItem({
      type: 'issue',
      content: `Task "${task.prompt.slice(0, 100)}" failed: ${task.error}`,
      source: 'task',
      sourceId: task.id,
      projectPath,
      createdBy: task.createdBy,
    })
  }

  private async extractFromText(
    text: string,
    sourceId: string,
    projectPath: string,
  ): Promise<MemoryItem[]> {
    const prompt = `Analyze the following AI task execution summary and extract important facts.
Return a JSON array of objects with fields: type, content.

Types:
- "decision": Technical decisions made during execution
- "issue": Problems discovered or created
- "context": Project context learned

Only extract genuinely important facts. If nothing worth remembering, return [].

Summary:
${text.slice(0, 3000)}

Respond with ONLY a valid JSON array, no markdown fences:`

    try {
      const provider = await this.getProvider()
      const response = await provider.createMessage({
        model: MEMORY_MODEL,
        maxTokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      })

      const resultText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')

      const extracted = JSON.parse(stripFences(resultText)) as Array<{
        type: string
        content: string
      }>
      const now = new Date().toISOString()

      return extracted.map((e) => ({
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: e.type as MemoryItem['type'],
        content: e.content,
        source: 'task' as const,
        sourceId,
        projectPath,
        createdAt: now,
      }))
    } catch (err) {
      log.error('AI extraction from text failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }
}

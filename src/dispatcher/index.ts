/**
 * Platform-agnostic Dispatcher (Layer 1 AI).
 *
 * Routes user intent: chat, query_memory, or create_task.
 * Accepts any IMPlatform and operates on IMMessage.
 *
 * This is a thin orchestration layer. Actual logic lives in:
 *   - ./ai-client.ts  — AI API interaction, tool loop, JSON parsing
 *   - ./prompt.ts     — system prompt and user-prompt building
 *   - ./tools.ts      — read-only tool definitions and executors
 */

import type { IMMessage, IMPlatform } from '../channels/types.js'
import type { WebhookServer } from '../webhook/server.js'
import { createLogger } from '../infra/logger.js'
import { getMemoryStore } from '../memory/store.js'
import { MemoryExtractor } from '../memory/extractor.js'
import { MemoryRetriever } from '../memory/retriever.js'
import type { MemoryStore } from '../memory/store.js'
import type { MemorySearchResult } from '../memory/types.js'
import { ProjectScanner } from '../prompt/project-scanner.js'
import { DispatcherAIClient } from './ai-client.js'
import { getDispatcherMemoryConfig, hasMemoryIntent } from './config.js'
import {
  buildDispatcherSystemPrompt,
  buildDispatcherPrompt,
  buildEnrichedTaskDescription,
} from './prompt.js'

const log = createLogger('dispatcher')

export class Dispatcher {
  private memoryExtractor: MemoryExtractor | null = null
  private memoryRetriever: MemoryRetriever | null = null
  private memoryStoreRef: MemoryStore | null = null

  private readonly aiClient = new DispatcherAIClient()
  private readonly projectScanner = new ProjectScanner()

  constructor(
    private platform: IMPlatform,
    private server: WebhookServer,
  ) {}

  async recordMessage(msg: IMMessage): Promise<void> {
    const projectPath = this.server.getProjectPath()
    const { store } = await this.getMemoryTools()

    store.addMessage(
      msg.chatId,
      {
        role: 'user',
        content: msg.text,
        senderName: msg.senderName,
        timestamp: new Date().toISOString(),
      },
      projectPath,
    )
  }

  async dispatch(msg: IMMessage): Promise<void> {
    const projectPath = this.server.getProjectPath()
    const { store, extractor, retriever } = await this.getMemoryTools()
    const memoryConfig = getDispatcherMemoryConfig()

    const conversation = store.addMessage(
      msg.chatId,
      {
        role: 'user',
        content: msg.text,
        senderName: msg.senderName,
        timestamp: new Date().toISOString(),
      },
      projectPath,
    )

    const memoryResults = await retriever.retrieveWithScores(msg.text, projectPath, {
      limit: memoryConfig.retrievalTopK,
      minScore: memoryConfig.retrievalMinScore,
    })
    const memorySummary = retriever.formatSearchResultsAsSummary(memoryResults, {
      maxItems: memoryConfig.maxMemorySummaryItems,
      maxCharsPerItem: memoryConfig.maxMemorySummaryCharsPerItem,
    })
    const detailedMemories = this.selectDetailedMemories(
      msg.text,
      memoryResults,
      memoryConfig.detailMinScore,
      memoryConfig.maxDetailedMemoryItems,
    )
    const detailedMemoryContext = retriever.formatAsContext(
      detailedMemories.map((result) => result.item),
      memoryConfig.maxDetailedMemoryCharsPerItem,
    )
    const recentChat = store.getRecentMessages(msg.chatId, memoryConfig.recentChatCount)

    // Build a ParsedMessage-like object for backward compat with prompt builder
    const parsed = {
      text: msg.text,
      sender: { name: msg.senderName || 'unknown', openId: msg.senderId },
      chatId: msg.chatId,
      messageId: msg.messageId,
      mentions: (msg.mentions || []).map((m) => ({
        key: '',
        openId: m.id,
        name: m.name,
      })),
      attachments: msg.attachments,
      links: msg.links,
    }

    const promptBuild = buildDispatcherPrompt(parsed, recentChat, {
      projectContext: this.projectScanner.getProjectContext(projectPath),
      memoryStore: this.memoryStoreRef,
      retriever,
      projectPath,
      memorySummary,
      detailedMemoryContext,
      memoryIntent: hasMemoryIntent(msg.text),
      memoryConfig,
    })

    if (memoryConfig.metricsEnabled) {
      log.info('Dispatcher context metrics', {
        queryLength: msg.text.length,
        retrievedCount: memoryResults.length,
        topScore: memoryResults[0]?.score ?? 0,
        detailedCount: detailedMemories.length,
        ...promptBuild.metrics,
      })
    }

    const systemPrompt = buildDispatcherSystemPrompt({
      projectRules: this.projectScanner.getProjectRules(projectPath),
      memoryAvailable: !!this.memoryStoreRef,
    })

    // Send "thinking" card as a thread reply to the user's message
    const replyOpts = { replyTo: msg.messageId }
    let thinkingCardId: string | undefined
    try {
      thinkingCardId = await this.platform.sendCard(
        msg.chatId,
        { markdown: '🔍 正在分析你的消息…', header: { title: '💭 思考中', color: 'blue' } },
        replyOpts,
      )
    } catch {
      log.warn('Failed to send thinking card')
    }

    let lastProgressUpdate = 0
    const onProgress = thinkingCardId
      ? (info: { round: number; toolName: string }) => {
          const now = Date.now()
          if (now - lastProgressUpdate < 3000) return
          lastProgressUpdate = now
          this.platform.updateCard(thinkingCardId!, {
            markdown: `🔍 正在分析（第 ${info.round} 轮）\n工具: \`${info.toolName}\``,
            header: { title: '💭 思考中', color: 'blue' },
          })
        }
      : undefined

    let response: import('./ai-client.js').DispatcherResponse
    try {
      response = await this.aiClient.call(
        promptBuild.prompt,
        msg.attachments,
        projectPath,
        systemPrompt,
        onProgress,
      )
    } catch (err: any) {
      log.error('AI call failed', { error: err.message || String(err), chatId: msg.chatId })
      const errorMsg = `抱歉，处理消息时出错了: ${err.message || '未知错误'}`
      if (thinkingCardId) {
        const updated = await this.platform.updateCard(thinkingCardId, {
          markdown: errorMsg,
          header: { title: '❌ 处理失败', color: 'red' },
        })
        if (!updated) {
          await this.platform.sendText(msg.chatId, errorMsg, replyOpts)
        }
      } else {
        await this.platform.sendText(msg.chatId, errorMsg, replyOpts)
      }
      return
    }

    await this.routeResponse(response, msg, {
      store,
      extractor,
      conversation,
      projectPath,
      thinkingCardId,
      replyTo: msg.messageId,
    })
  }

  /* ---------------------------------------------------------------- */
  /*  Intent routing                                                   */
  /* ---------------------------------------------------------------- */

  private async deliverReply(
    chatId: string,
    markdown: string,
    thinkingCardId?: string,
    header?: { title: string; color?: string },
    replyTo?: string,
  ): Promise<void> {
    if (thinkingCardId) {
      const ok = await this.platform.updateCard(thinkingCardId, { markdown, header })
      if (ok) return
      log.warn('updateCard failed, falling back to new message')
    }
    await this.platform.sendCard(chatId, { markdown, header }, { replyTo })
  }

  private async routeResponse(
    response: import('./ai-client.js').DispatcherResponse,
    msg: IMMessage,
    ctx: {
      store: MemoryStore
      extractor: MemoryExtractor
      conversation: import('../memory/types.js').ConversationRecord
      projectPath: string
      thinkingCardId?: string
      replyTo?: string
    },
  ): Promise<void> {
    switch (response.intent) {
      case 'chat': {
        const reply = response.reply || '收到'
        await this.deliverReply(msg.chatId, reply, ctx.thinkingCardId, undefined, ctx.replyTo)
        ctx.store.addMessage(
          msg.chatId,
          { role: 'assistant', content: reply, timestamp: new Date().toISOString() },
          ctx.projectPath,
        )
        await ctx.extractor.maybeExtractFromConversation(ctx.conversation)
        break
      }

      case 'query_memory': {
        const reply = response.reply || '没有找到相关记录'
        await this.deliverReply(msg.chatId, reply, ctx.thinkingCardId, undefined, ctx.replyTo)
        ctx.store.addMessage(
          msg.chatId,
          { role: 'assistant', content: reply, timestamp: new Date().toISOString() },
          ctx.projectPath,
        )
        break
      }

      case 'create_task': {
        if (!response.taskTitle) {
          await this.deliverReply(
            msg.chatId,
            '无法提取任务标题，请更详细地描述你的需求',
            ctx.thinkingCardId,
            undefined,
            ctx.replyTo,
          )
          return
        }

        const enrichedDescription = buildEnrichedTaskDescription(
          response.taskDescription || response.taskTitle,
          msg.attachments,
          msg.links,
          msg.senderName || 'unknown',
        )

        const taskId = await this.server.createTaskFromIM({
          title: response.taskTitle,
          description: enrichedDescription,
          createdBy: msg.senderName || 'unknown',
          metadata: {
            imChatId: msg.chatId,
            imMessageId: msg.messageId,
            imPlatform: this.platform.id,
          },
          attachments: msg.attachments.map((a) => ({
            filename: a.filename,
            originalname: a.originalname,
            path: a.path,
            mimetype: a.mimetype,
          })),
        })

        const taskCard = `📋 任务ID: \`${taskId}\`\n⏳ 正在处理中...`
        const taskHeader = { title: `✅ 任务已创建: ${response.taskTitle}`, color: 'blue' }

        let cardMessageId: string | undefined
        if (ctx.thinkingCardId) {
          const ok = await this.platform.updateCard(ctx.thinkingCardId, {
            markdown: taskCard,
            header: taskHeader,
          })
          if (ok) {
            cardMessageId = ctx.thinkingCardId
          }
        }
        if (!cardMessageId) {
          cardMessageId = await this.platform.sendCard(
            msg.chatId,
            { markdown: taskCard, header: taskHeader },
            { replyTo: ctx.replyTo },
          )
        }

        if (cardMessageId) {
          this.server.updateTaskMetadata(taskId, { imCardMessageId: cardMessageId })
        }

        ctx.store.addMessage(
          msg.chatId,
          {
            role: 'assistant',
            content: `Created task: ${taskId} - ${response.taskTitle}`,
            timestamp: new Date().toISOString(),
          },
          ctx.projectPath,
        )
        break
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Memory helpers                                                   */
  /* ---------------------------------------------------------------- */

  private selectDetailedMemories(
    query: string,
    results: MemorySearchResult[],
    minScore: number,
    maxItems: number,
  ): MemorySearchResult[] {
    if (results.length === 0 || maxItems <= 0) return []
    const topScore = results[0]?.score ?? 0
    if (!hasMemoryIntent(query) && topScore < minScore) return []
    return results.slice(0, maxItems)
  }

  private async getMemoryTools() {
    const store = await getMemoryStore()
    this.memoryStoreRef = store
    if (!this.memoryExtractor) {
      this.memoryExtractor = new MemoryExtractor(store)
    }
    if (!this.memoryRetriever) {
      this.memoryRetriever = new MemoryRetriever(store)
    }
    return { store, extractor: this.memoryExtractor, retriever: this.memoryRetriever }
  }
}

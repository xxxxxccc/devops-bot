/**
 * Platform-agnostic Dispatcher (Layer 1 AI).
 *
 * Routes user intent via three-tier task execution:
 *   - execute_task  (Tier 1): low risk, immediate execution
 *   - propose_task  (Tier 2): medium risk, issue-first + approval
 *   - create_issue  (Tier 3): high risk / unclear, discussion only
 *
 * Also handles: chat, query_memory, add_project, remove_project.
 *
 * In multi-project mode, the AI selects the target project from a per-chat
 * project list included in the prompt.
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
import { createIssue, buildIssueBody } from '../sandbox/issue-creator.js'
import { detectRepo } from '../sandbox/pr-creator.js'
import type { ApprovalStore } from '../approval/store.js'
import type { DispatcherResponse } from './ai-client.js'
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
  private approvalStore: ApprovalStore | null = null

  private readonly aiClient = new DispatcherAIClient()
  private readonly projectScanner = new ProjectScanner()

  constructor(
    private platform: IMPlatform,
    private server: WebhookServer,
  ) {}

  setApprovalStore(store: ApprovalStore): void {
    this.approvalStore = store
  }

  async recordMessage(msg: IMMessage): Promise<void> {
    const projectPath = this.server.getProjectPath() || ''
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
    const { store, extractor, retriever } = await this.getMemoryTools()
    const memoryConfig = getDispatcherMemoryConfig()

    // Resolve project context for this chat
    const resolver = await this.server.getProjectResolver()
    const chatProjects = resolver.getProjectsForChat(msg.chatId)
    const fallbackPath = resolver.getFallbackProject()
    const effectivePath = chatProjects.length > 0 ? chatProjects[0].localPath : fallbackPath || ''

    const conversation = store.addMessage(
      msg.chatId,
      {
        role: 'user',
        content: msg.text,
        senderName: msg.senderName,
        timestamp: new Date().toISOString(),
      },
      effectivePath,
    )

    const memoryResults = await retriever.retrieveWithScores(msg.text, effectivePath, {
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
      projectContext: effectivePath ? this.projectScanner.getProjectContext(effectivePath) : '',
      memoryStore: this.memoryStoreRef,
      retriever,
      projectPath: effectivePath,
      memorySummary,
      detailedMemoryContext,
      memoryIntent: hasMemoryIntent(msg.text),
      memoryConfig,
      chatProjects,
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
      projectRules: effectivePath ? this.projectScanner.getProjectRules(effectivePath) : '',
      memoryAvailable: !!this.memoryStoreRef,
    })

    // Send "thinking" card
    const replyOpts = { replyTo: msg.messageId }
    let thinkingCardId: string | undefined
    try {
      thinkingCardId = await this.platform.sendCard(
        msg.chatId,
        { markdown: '🔍 Analyzing your message…', header: { title: '💭 Thinking', color: 'blue' } },
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
            markdown: `🔍 Analyzing (round ${info.round})\nTool: \`${info.toolName}\``,
            header: { title: '💭 Thinking', color: 'blue' },
          })
        }
      : undefined

    let response: DispatcherResponse
    try {
      response = await this.aiClient.call(
        promptBuild.prompt,
        msg.attachments,
        effectivePath,
        systemPrompt,
        onProgress,
      )
    } catch (err: any) {
      log.error('AI call failed', { error: err.message || String(err), chatId: msg.chatId })
      const errorMsg = `Sorry, an error occurred while processing your message: ${err.message || 'Unknown error'}`
      if (thinkingCardId) {
        const updated = await this.platform.updateCard(thinkingCardId, {
          markdown: errorMsg,
          header: { title: '❌ Processing Failed', color: 'red' },
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
      projectPath: effectivePath,
      thinkingCardId,
      replyTo: msg.messageId,
      chatProjects,
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

  /**
   * Resolve the project path for the current intent.
   * Uses the AI-selected projectId or falls back to the first project in the list.
   */
  private async resolveProjectPath(
    response: DispatcherResponse,
    chatId: string,
    _chatProjects: Array<{ id: string; localPath: string }>,
    fallbackPath: string,
  ): Promise<string> {
    if (!response.projectId) return fallbackPath

    if (response.projectId === 'local') return fallbackPath

    const resolver = await this.server.getProjectResolver()
    const synced = await resolver.syncAndResolve(response.projectId, chatId)
    return synced || fallbackPath
  }

  private async routeResponse(
    response: DispatcherResponse,
    msg: IMMessage,
    ctx: {
      store: MemoryStore
      extractor: MemoryExtractor
      conversation: import('../memory/types.js').ConversationRecord
      projectPath: string
      thinkingCardId?: string
      replyTo?: string
      chatProjects: Array<{ id: string; localPath: string }>
    },
  ): Promise<void> {
    switch (response.intent) {
      case 'chat': {
        const reply = response.reply || 'Got it'
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
        const reply = response.reply || 'No relevant records found'
        await this.deliverReply(msg.chatId, reply, ctx.thinkingCardId, undefined, ctx.replyTo)
        ctx.store.addMessage(
          msg.chatId,
          { role: 'assistant', content: reply, timestamp: new Date().toISOString() },
          ctx.projectPath,
        )
        break
      }

      case 'execute_task': {
        await this.handleExecuteTask(response, msg, ctx)
        break
      }

      case 'propose_task': {
        await this.handleProposeTask(response, msg, ctx)
        break
      }

      case 'create_issue': {
        await this.handleCreateIssue(response, msg, ctx)
        break
      }

      case 'add_project': {
        await this.handleAddProject(response, msg, ctx)
        break
      }

      case 'remove_project': {
        await this.handleRemoveProject(response, msg, ctx)
        break
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Tier 1: execute_task (low risk, immediate execution)             */
  /* ---------------------------------------------------------------- */

  private async handleExecuteTask(
    response: DispatcherResponse,
    msg: IMMessage,
    ctx: {
      store: MemoryStore
      projectPath: string
      thinkingCardId?: string
      replyTo?: string
      chatProjects: Array<{ id: string; localPath: string }>
    },
  ): Promise<void> {
    if (!response.taskTitle) {
      await this.deliverReply(
        msg.chatId,
        'Could not extract task title. Please describe your request in more detail.',
        ctx.thinkingCardId,
        undefined,
        ctx.replyTo,
      )
      return
    }

    const projectPath = await this.resolveProjectPath(
      response,
      msg.chatId,
      ctx.chatProjects,
      ctx.projectPath,
    )

    const enrichedDescription = buildEnrichedTaskDescription(
      response.taskDescription || response.taskTitle,
      msg.attachments,
      msg.links,
      msg.senderName || 'unknown',
    )

    // Create tracking Issue (non-blocking)
    const issue = await createIssue({
      projectPath,
      title: response.taskTitle,
      body: buildIssueBody({
        description: enrichedDescription,
        createdBy: msg.senderName || 'unknown',
      }),
      labels: response.issueLabels ?? ['devops-bot'],
    }).catch((e) => {
      log.warn('Issue creation failed, proceeding with task', {
        error: e instanceof Error ? e.message : String(e),
      })
      return undefined
    })

    const taskId = await this.server.createTaskFromIM({
      title: response.taskTitle,
      description: enrichedDescription,
      createdBy: msg.senderName || 'unknown',
      projectPath,
      metadata: {
        imChatId: msg.chatId,
        imMessageId: msg.messageId,
        imPlatform: this.platform.id,
        issueUrl: issue?.url,
        issueNumber: issue?.number,
        riskReason: response.riskReason,
        tier: 'execute_task',
        language: response.language,
      },
      attachments: msg.attachments.map((a) => ({
        filename: a.filename,
        originalname: a.originalname,
        path: a.path,
        mimetype: a.mimetype,
      })),
    })

    const riskLine = response.riskReason ? `\n📊 Risk assessment: ${response.riskReason}` : ''
    const issueLine = issue ? `\n🔗 Issue: ${issue.url}` : ''
    const taskCard = `📋 Task ID: \`${taskId}\`${issueLine}${riskLine}\n⏳ Processing...`
    const taskHeader = { title: `⚡ Executing: ${response.taskTitle}`, color: 'blue' }

    let cardMessageId: string | undefined
    if (ctx.thinkingCardId) {
      const ok = await this.platform.updateCard(ctx.thinkingCardId, {
        markdown: taskCard,
        header: taskHeader,
      })
      if (ok) cardMessageId = ctx.thinkingCardId
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
        content: `Executing task: ${taskId} - ${response.taskTitle}${issue ? ` (Issue: ${issue.url})` : ''}`,
        timestamp: new Date().toISOString(),
      },
      ctx.projectPath,
    )
  }

  /* ---------------------------------------------------------------- */
  /*  Tier 2: propose_task (medium risk, needs approval)               */
  /* ---------------------------------------------------------------- */

  private async handleProposeTask(
    response: DispatcherResponse,
    msg: IMMessage,
    ctx: {
      store: MemoryStore
      projectPath: string
      thinkingCardId?: string
      replyTo?: string
      chatProjects: Array<{ id: string; localPath: string }>
    },
  ): Promise<void> {
    if (!response.taskTitle) {
      await this.deliverReply(
        msg.chatId,
        'Could not extract task title. Please describe your request in more detail.',
        ctx.thinkingCardId,
        undefined,
        ctx.replyTo,
      )
      return
    }

    const projectPath = await this.resolveProjectPath(
      response,
      msg.chatId,
      ctx.chatProjects,
      ctx.projectPath,
    )

    const enrichedDescription = buildEnrichedTaskDescription(
      response.taskDescription || response.taskTitle,
      msg.attachments,
      msg.links,
      msg.senderName || 'unknown',
    )

    const issueBody = [
      buildIssueBody({
        description: enrichedDescription,
        createdBy: msg.senderName || 'unknown',
      }),
      '',
      '## Approval',
      '',
      'React with ✅ on this issue to approve and start automatic execution.',
      response.riskReason ? `\n**Risk assessment:** ${response.riskReason}` : '',
    ].join('\n')

    const createdIssue = await createIssue({
      projectPath,
      title: response.taskTitle,
      body: issueBody,
      labels: response.issueLabels ?? ['devops-bot', 'needs-approval'],
    })

    let issueCard: string
    let issueHeader: { title: string; color: string }

    if (createdIssue) {
      const riskLine = response.riskReason ? `\n📊 Approval needed: ${response.riskReason}` : ''
      issueCard = `📝 Issue: ${createdIssue.url}${riskLine}\n\n${response.reply || 'React with ✅ on the Issue to approve execution.'}`
      issueHeader = { title: `📋 Pending Approval: ${response.taskTitle}`, color: 'orange' }

      await this.persistApproval(createdIssue, {
        projectPath,
        taskTitle: response.taskTitle!,
        taskDesc: enrichedDescription,
        createdBy: msg.senderName || 'unknown',
        chatId: msg.chatId,
        messageId: msg.messageId,
        riskReason: response.riskReason ?? null,
        issueLabels: response.issueLabels ?? ['devops-bot', 'needs-approval'],
      })
    } else {
      issueCard = `⚠️ Issue creation failed\n\n**${response.taskTitle}**\n${response.taskDescription || ''}`
      issueHeader = { title: '📋 Request Recorded', color: 'orange' }
    }

    await this.deliverReply(msg.chatId, issueCard, ctx.thinkingCardId, issueHeader, ctx.replyTo)

    if (createdIssue) {
      await this.platform
        .sendText(
          msg.chatId,
          `📋 Issue created: ${createdIssue.url}\nReact with ✅ on the Issue to approve execution.`,
          { replyTo: msg.messageId },
        )
        .catch(() => {
          // Non-critical: thread notification is best-effort
        })
    }

    ctx.store.addMessage(
      msg.chatId,
      {
        role: 'assistant',
        content: `Proposed task: ${response.taskTitle}${createdIssue ? ` (${createdIssue.url})` : ''} — awaiting approval`,
        timestamp: new Date().toISOString(),
      },
      ctx.projectPath,
    )
  }

  /* ---------------------------------------------------------------- */
  /*  Approval persistence helper                                      */
  /* ---------------------------------------------------------------- */

  private async persistApproval(
    createdIssue: { url: string; number: number },
    data: {
      projectPath: string
      taskTitle: string
      taskDesc: string
      createdBy: string
      chatId: string
      messageId: string
      riskReason: string | null
      issueLabels: string[] | null
    },
  ): Promise<void> {
    if (!this.approvalStore) {
      log.warn('ApprovalStore not available, skipping approval persistence')
      return
    }

    try {
      const repoInfo = await detectRepo(data.projectPath)
      if (repoInfo.platform !== 'github' && repoInfo.platform !== 'gitlab') {
        log.warn('Unknown platform, cannot track approval', { platform: repoInfo.platform })
        return
      }

      this.approvalStore.add({
        issueNumber: createdIssue.number,
        issueUrl: createdIssue.url,
        platform: repoInfo.platform,
        host: repoInfo.host,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        projectPath: data.projectPath,
        taskTitle: data.taskTitle,
        taskDesc: data.taskDesc,
        createdBy: data.createdBy,
        imChatId: data.chatId,
        imMessageId: data.messageId,
        imPlatform: this.platform.id,
        riskReason: data.riskReason,
        issueLabels: data.issueLabels,
      })
    } catch (err) {
      log.error('Failed to persist approval', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Tier 3: create_issue (high risk, discussion only)                */
  /* ---------------------------------------------------------------- */

  private async handleCreateIssue(
    response: DispatcherResponse,
    msg: IMMessage,
    ctx: {
      store: MemoryStore
      projectPath: string
      thinkingCardId?: string
      replyTo?: string
      chatProjects: Array<{ id: string; localPath: string }>
    },
  ): Promise<void> {
    if (!response.taskTitle) {
      await this.deliverReply(
        msg.chatId,
        'Could not extract issue title. Please describe your request in more detail.',
        ctx.thinkingCardId,
        undefined,
        ctx.replyTo,
      )
      return
    }

    const projectPath = await this.resolveProjectPath(
      response,
      msg.chatId,
      ctx.chatProjects,
      ctx.projectPath,
    )

    const issueDescription = buildEnrichedTaskDescription(
      response.taskDescription || response.taskTitle,
      msg.attachments,
      msg.links,
      msg.senderName || 'unknown',
    )

    const issueBodyParts = [
      buildIssueBody({
        description: issueDescription,
        createdBy: msg.senderName || 'unknown',
      }),
    ]
    if (response.riskReason) {
      issueBodyParts.push('', '## Why not executed automatically', '', response.riskReason)
    }

    const createdIssue = await createIssue({
      projectPath,
      title: response.taskTitle,
      body: issueBodyParts.join('\n'),
      labels: response.issueLabels ?? ['devops-bot'],
    })

    let issueCard: string
    let issueHeader: { title: string; color: string }
    if (createdIssue) {
      const riskLine = response.riskReason
        ? `\n📊 Not executed because: ${response.riskReason}`
        : ''
      issueCard = `📝 Issue: ${createdIssue.url}${riskLine}\n\n${response.reply || response.taskDescription || ''}`
      issueHeader = { title: `📋 Issue Created: ${response.taskTitle}`, color: 'purple' }
    } else {
      issueCard = `⚠️ Issue creation failed (missing token or CLI tool)\n\n**${response.taskTitle}**\n${response.taskDescription || ''}\n\n${response.reply || ''}`
      issueHeader = { title: '📋 Request Recorded', color: 'orange' }
    }

    await this.deliverReply(msg.chatId, issueCard, ctx.thinkingCardId, issueHeader, ctx.replyTo)

    if (createdIssue) {
      await this.platform
        .sendText(msg.chatId, `📋 Issue created: ${createdIssue.url}`, {
          replyTo: msg.messageId,
        })
        .catch(() => {
          // Non-critical: thread notification is best-effort
        })
    }

    ctx.store.addMessage(
      msg.chatId,
      {
        role: 'assistant',
        content: `Created issue: ${response.taskTitle}${createdIssue ? ` (${createdIssue.url})` : ''}`,
        timestamp: new Date().toISOString(),
      },
      ctx.projectPath,
    )
  }

  /* ---------------------------------------------------------------- */
  /*  Project management intents                                       */
  /* ---------------------------------------------------------------- */

  private async handleAddProject(
    response: DispatcherResponse,
    msg: IMMessage,
    ctx: { thinkingCardId?: string; replyTo?: string; store: MemoryStore; projectPath: string },
  ): Promise<void> {
    if (!response.gitUrl) {
      await this.deliverReply(
        msg.chatId,
        'Please provide a Git repository URL (e.g. https://github.com/org/repo)',
        ctx.thinkingCardId,
        undefined,
        ctx.replyTo,
      )
      return
    }

    const resolver = await this.server.getProjectResolver()

    await this.deliverReply(
      msg.chatId,
      `🔄 Adding project ${response.gitUrl}…`,
      ctx.thinkingCardId,
      { title: '📦 Adding Project', color: 'blue' },
      ctx.replyTo,
    )

    const project = await resolver.ensureAndRegister(response.gitUrl, msg.chatId)
    if (!project) {
      await this.platform.sendText(
        msg.chatId,
        `❌ Failed to add project. Please verify the URL is correct and you have access: ${response.gitUrl}`,
        { replyTo: msg.messageId },
      )
      return
    }

    const allProjects = resolver.getProjectsForChat(msg.chatId)
    const projectList = allProjects.map((p, i) => `${i + 1}. \`${p.id}\``).join('\n')

    await this.platform.sendCard(
      msg.chatId,
      {
        markdown: `✅ Project added: \`${project.id}\`\n\n**Projects bound to this chat:**\n${projectList}`,
        header: { title: '📦 Project Added', color: 'green' },
      },
      { replyTo: msg.messageId },
    )

    ctx.store.addMessage(
      msg.chatId,
      {
        role: 'assistant',
        content: `Added project: ${project.id} (${response.gitUrl})`,
        timestamp: new Date().toISOString(),
      },
      ctx.projectPath,
    )
  }

  private async handleRemoveProject(
    response: DispatcherResponse,
    msg: IMMessage,
    ctx: { thinkingCardId?: string; replyTo?: string; store: MemoryStore; projectPath: string },
  ): Promise<void> {
    if (!response.projectId) {
      await this.deliverReply(
        msg.chatId,
        'Please specify which project to remove.',
        ctx.thinkingCardId,
        undefined,
        ctx.replyTo,
      )
      return
    }

    const resolver = await this.server.getProjectResolver()
    const removed = resolver.removeFromChat(msg.chatId, response.projectId)

    if (removed) {
      const remaining = resolver.getProjectsForChat(msg.chatId)
      const list =
        remaining.length > 0
          ? remaining.map((p, i) => `${i + 1}. \`${p.id}\``).join('\n')
          : '(none)'

      await this.deliverReply(
        msg.chatId,
        `✅ Project removed: \`${response.projectId}\`\n\n**Remaining projects:**\n${list}`,
        ctx.thinkingCardId,
        { title: '📦 Project Removed', color: 'green' },
        ctx.replyTo,
      )
    } else {
      await this.deliverReply(
        msg.chatId,
        `No binding found for project \`${response.projectId}\``,
        ctx.thinkingCardId,
        undefined,
        ctx.replyTo,
      )
    }

    ctx.store.addMessage(
      msg.chatId,
      {
        role: 'assistant',
        content: `Removed project binding: ${response.projectId}`,
        timestamp: new Date().toISOString(),
      },
      ctx.projectPath,
    )
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

/**
 * Feishu (Lark) IM Platform adapter.
 *
 * Implements IMPlatform for Feishu (Lark).
 * Feishu-specific logic: WebSocket connection, card rendering, debouncing.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { Attachment, IMCard, IMMessage, IMPlatform } from '../types.js'
import { FeishuMessageParser } from './parser.js'
import { retry } from '../../infra/retry.js'
import { createLogger } from '../../infra/logger.js'

const log = createLogger('feishu')

const DEDUP_CACHE_SIZE = 200
const MENTION_DEBOUNCE_MS = 3000
const MAX_DEBOUNCE_MS = 15_000
const ATTACHMENT_MSG_TYPES = new Set(['image', 'file'])

interface PendingDispatch {
  primary: IMMessage
  followUps: IMMessage[]
  timer: ReturnType<typeof setTimeout>
  createdAt: number
}

export interface FeishuConfig {
  appId: string
  appSecret: string
}

export class FeishuChannel implements IMPlatform {
  readonly id = 'feishu' as const

  private client: lark.Client
  private wsClient: lark.WSClient
  private parser: FeishuMessageParser
  private botOpenId: string | null = null
  private processedMessages = new Set<string>()
  private startedAt = 0
  private pendingDispatches = new Map<string, PendingDispatch>()
  private onMessageHandler: ((msg: IMMessage) => Promise<void>) | null = null
  private onPassiveHandler: ((msg: IMMessage) => Promise<void>) | null = null

  constructor(config: FeishuConfig) {
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    }

    this.client = new lark.Client(baseConfig)
    this.parser = new FeishuMessageParser(this.client)
    this.wsClient = new lark.WSClient({
      ...baseConfig,
      loggerLevel: lark.LoggerLevel.info,
    })
  }

  async connect(options: {
    onMessage: (msg: IMMessage) => Promise<void>
    onPassiveMessage?: (msg: IMMessage) => Promise<void>
  }): Promise<void> {
    this.onMessageHandler = options.onMessage
    this.onPassiveHandler = options.onPassiveMessage ?? null
    this.startedAt = Date.now()

    await this.resolveBotOpenId()

    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          await this.handleEvent(data)
        },
      }),
    })
    log.info('Feishu WebSocket connection started')
  }

  getBotId(): string {
    return this.botOpenId || ''
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await retry(
        () =>
          this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ text }),
              msg_type: 'text',
            },
          }),
        {
          maxAttempts: 3,
          onRetry: (err, attempt, delay) =>
            log.warn(`Reply retry ${attempt}`, {
              chatId,
              delay,
              error: err instanceof Error ? err.message : String(err),
            }),
        },
      )
    } catch (err) {
      log.error(`Failed to send reply to ${chatId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async sendCard(chatId: string, card: IMCard): Promise<string | undefined> {
    try {
      const resp = await retry(
        () =>
          this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: this.buildCardJson(card),
              msg_type: 'interactive',
            },
          }),
        {
          maxAttempts: 3,
          onRetry: (err, attempt, delay) =>
            log.warn(`Markdown reply retry ${attempt}`, {
              chatId,
              delay,
              error: err instanceof Error ? err.message : String(err),
            }),
        },
      )
      return (resp.data?.message_id as string) || undefined
    } catch (err) {
      log.error(`Failed to send card to ${chatId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
      await this.sendText(chatId, card.markdown)
      return undefined
    }
  }

  async updateCard(messageId: string, card: IMCard): Promise<boolean> {
    try {
      await retry(
        () =>
          this.client.im.message.patch({
            path: { message_id: messageId },
            data: { content: this.buildCardJson(card) },
          }),
        {
          maxAttempts: 3,
          onRetry: (err, attempt, delay) =>
            log.warn(`Update card retry ${attempt}`, {
              messageId,
              delay,
              error: err instanceof Error ? err.message : String(err),
            }),
        },
      )
      return true
    } catch (err) {
      log.error(`Failed to update card ${messageId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  async downloadAttachment(_attachment: Attachment): Promise<{ data: Buffer; filename: string }> {
    throw new Error('Feishu attachments are downloaded during parsing, not on demand')
  }

  /* ---------------------------------------------------------------- */
  /*  Card rendering                                                   */
  /* ---------------------------------------------------------------- */

  private adaptMarkdown(md: string): string {
    let result = md.replace(/```[\w]*\n([\s\S]*?)```/g, (_m, code: string) => {
      return code
        .split('\n')
        .map((line: string) => `    ${line}`)
        .join('\n')
    })
    result = result.replace(/`([^`]+)`/g, '**$1**')
    return result
  }

  private buildCardJson(card: IMCard): string {
    const cardObj: Record<string, unknown> = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: this.adaptMarkdown(card.markdown) }],
    }
    if (card.header) {
      cardObj.header = {
        title: { content: card.header.title, tag: 'plain_text' },
        template: card.header.color || 'blue',
      }
    }
    return JSON.stringify(cardObj)
  }

  /* ---------------------------------------------------------------- */
  /*  Event handling + debounce                                        */
  /* ---------------------------------------------------------------- */

  private async resolveBotOpenId() {
    try {
      const resp: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      })
      const openId = resp?.bot?.open_id
      if (openId) {
        this.botOpenId = openId
        log.info(`Bot open_id resolved: ${this.botOpenId}`)
      } else {
        log.warn('Could not resolve bot open_id')
      }
    } catch (err) {
      log.warn('Failed to fetch bot info', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async handleEvent(eventData: any) {
    try {
      const createTime = eventData?.message?.create_time
      if (createTime) {
        const messageMs = parseInt(createTime, 10)
        const messageTimestamp = messageMs < 1e12 ? messageMs * 1000 : messageMs
        if (messageTimestamp < this.startedAt) return
      }

      const messageId: string | undefined = eventData?.message?.message_id
      if (messageId) {
        if (this.processedMessages.has(messageId)) return
        this.processedMessages.add(messageId)
        if (this.processedMessages.size > DEDUP_CACHE_SIZE) {
          const first = this.processedMessages.values().next().value!
          this.processedMessages.delete(first)
        }
      }

      const chatId: string | undefined = eventData?.message?.chat_id
      const msgType: string | undefined = eventData?.message?.message_type
      if (chatId && this.pendingDispatches.has(chatId) && ATTACHMENT_MSG_TYPES.has(msgType ?? '')) {
        this.extendDebounce(chatId)
      }

      const parsed = await this.parser.parse(eventData)
      if (parsed.sender.openId === 'unknown') return

      const msg: IMMessage = {
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        senderId: parsed.sender.openId,
        senderName: parsed.sender.name,
        text: parsed.text,
        mentions: parsed.mentions.map((m) => ({ id: m.openId, name: m.name })),
        attachments: parsed.attachments,
        links: parsed.links,
      }

      const isMentioned = this.isBotMentioned(parsed.mentions)

      log.info(
        `Message from ${msg.senderName}${isMentioned ? ' (@bot)' : ''}: ${msg.text.slice(0, 100)}`,
      )

      if (isMentioned) {
        this.scheduleDispatch(msg)
      } else if (this.pendingDispatches.has(msg.chatId)) {
        const pending = this.pendingDispatches.get(msg.chatId)!
        pending.followUps.push(msg)
        if (msg.attachments.length > 0) {
          this.extendDebounce(msg.chatId)
        }
      } else {
        await this.onPassiveHandler?.(msg)
      }
    } catch (err: any) {
      log.error('Error handling message', {
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        const chatId = eventData?.message?.chat_id
        if (chatId) {
          await this.sendText(chatId, `处理消息时出错: ${err.message || '未知错误'}`)
        }
      } catch {
        // Ignore
      }
    }
  }

  private isBotMentioned(mentions: Array<{ openId: string }>): boolean {
    if (!this.botOpenId) return true
    return mentions.some((m) => m.openId === this.botOpenId)
  }

  private scheduleDispatch(msg: IMMessage): void {
    const existing = this.pendingDispatches.get(msg.chatId)
    if (existing) {
      existing.followUps.push(msg)
      this.extendDebounce(msg.chatId)
    } else {
      const timer = setTimeout(() => this.flushDispatch(msg.chatId), MENTION_DEBOUNCE_MS)
      this.pendingDispatches.set(msg.chatId, {
        primary: msg,
        followUps: [],
        timer,
        createdAt: Date.now(),
      })
    }
  }

  private extendDebounce(chatId: string): void {
    const pending = this.pendingDispatches.get(chatId)
    if (!pending) return

    const elapsed = Date.now() - pending.createdAt
    if (elapsed >= MAX_DEBOUNCE_MS) {
      clearTimeout(pending.timer)
      void this.flushDispatch(chatId)
      return
    }

    const remaining = MAX_DEBOUNCE_MS - elapsed
    const delay = Math.min(MENTION_DEBOUNCE_MS, remaining)
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => this.flushDispatch(chatId), delay)
  }

  private async flushDispatch(chatId: string): Promise<void> {
    const pending = this.pendingDispatches.get(chatId)
    if (!pending) return
    this.pendingDispatches.delete(chatId)

    // Record follow-ups as passive messages
    for (const msg of pending.followUps) {
      await this.onPassiveHandler?.(msg)
    }

    // Merge follow-up data into primary
    const merged = { ...pending.primary }
    for (const msg of pending.followUps) {
      const isPlaceholder = /^\[(Image|File:.*|media)\]$/.test(msg.text.trim())
      if (!isPlaceholder && msg.text.trim()) {
        merged.text += `\n${msg.text}`
      }
      merged.attachments.push(...msg.attachments)
      merged.links.push(...msg.links)
    }

    try {
      await this.onMessageHandler?.(merged)
    } catch (err: any) {
      log.error('Error dispatching merged message', {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        await this.sendText(chatId, `处理消息时出错: ${err.message || '未知错误'}`)
      } catch {
        // Ignore
      }
    }
  }
}

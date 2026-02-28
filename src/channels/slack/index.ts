/**
 * Slack IM Platform adapter.
 *
 * Uses @slack/bolt with Socket Mode (no public URL needed).
 */

import { App } from '@slack/bolt'
import type { Attachment, ExtractedLink, IMCard, IMMessage, IMPlatform } from '../types.js'
import { createLogger } from '../../infra/logger.js'

const log = createLogger('slack')

export interface SlackConfig {
  botToken: string
  appToken: string
}

export class SlackChannel implements IMPlatform {
  readonly id = 'slack' as const

  private app: App
  private botUserId = ''
  private onMessageHandler: ((msg: IMMessage) => Promise<void>) | null = null
  private onPassiveHandler: ((msg: IMMessage) => Promise<void>) | null = null

  constructor(config: SlackConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    })
  }

  async connect(options: {
    onMessage: (msg: IMMessage) => Promise<void>
    onPassiveMessage?: (msg: IMMessage) => Promise<void>
  }): Promise<void> {
    this.onMessageHandler = options.onMessage
    this.onPassiveHandler = options.onPassiveMessage ?? null

    // Resolve bot user ID
    try {
      const authResult = await this.app.client.auth.test()
      this.botUserId = authResult.user_id || ''
      log.info(`Slack bot user ID: ${this.botUserId}`)
    } catch (err) {
      log.warn('Failed to resolve Slack bot user ID', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Handle app_mention events (when someone @mentions the bot)
    this.app.event('app_mention', async ({ event, say }) => {
      try {
        const msg = await this.parseEvent(event)
        await this.onMessageHandler?.(msg)
      } catch (err: any) {
        log.error('Error handling app_mention', {
          error: err instanceof Error ? err.message : String(err),
        })
        try {
          await say(`处理消息时出错: ${err.message || '未知错误'}`)
        } catch {
          // Ignore
        }
      }
    })

    // Handle direct messages
    this.app.event('message', async ({ event }) => {
      try {
        const ev = event as any
        // Skip bot's own messages
        if (ev.bot_id || ev.user === this.botUserId) return
        // Skip threaded replies (subtype)
        if (ev.subtype) return

        const msg = await this.parseEvent(ev)

        // Direct messages (no channel prefix) are treated as @mentions
        if (ev.channel_type === 'im') {
          await this.onMessageHandler?.(msg)
        } else {
          await this.onPassiveHandler?.(msg)
        }
      } catch (err) {
        log.error('Error handling message', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    await this.app.start()
    log.info('Slack Socket Mode connection started')
  }

  getBotId(): string {
    return this.botUserId
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        channel: chatId,
        text,
      })
    } catch (err) {
      log.error(`Failed to send text to ${chatId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async sendCard(chatId: string, card: IMCard): Promise<string | undefined> {
    try {
      const blocks = this.buildBlocks(card)
      const resp = await this.app.client.chat.postMessage({
        channel: chatId,
        blocks,
        text: card.header?.title || card.markdown.slice(0, 100),
      })
      return resp.ts || undefined
    } catch (err) {
      log.error(`Failed to send card to ${chatId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
      await this.sendText(chatId, card.markdown)
      return undefined
    }
  }

  async updateCard(messageId: string, card: IMCard): Promise<boolean> {
    // messageId for Slack is "channel:ts" format
    const [channel, ts] = messageId.includes(':') ? messageId.split(':') : ['', messageId]
    if (!channel || !ts) {
      log.warn(`Invalid Slack message ID format: ${messageId}`)
      return false
    }

    try {
      const blocks = this.buildBlocks(card)
      await this.app.client.chat.update({
        channel,
        ts,
        blocks,
        text: card.header?.title || card.markdown.slice(0, 100),
      })
      return true
    } catch (err) {
      log.error(`Failed to update card ${messageId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  async downloadAttachment(_attachment: Attachment): Promise<{ data: Buffer; filename: string }> {
    throw new Error('Slack attachment download not yet implemented')
  }

  /* ---------------------------------------------------------------- */
  /*  Block Kit rendering                                              */
  /* ---------------------------------------------------------------- */

  private buildBlocks(card: IMCard): any[] {
    const blocks: any[] = []

    if (card.header) {
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: card.header.title },
      })
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: card.markdown },
    })

    return blocks
  }

  /* ---------------------------------------------------------------- */
  /*  Event parsing                                                    */
  /* ---------------------------------------------------------------- */

  private async parseEvent(event: any): Promise<IMMessage> {
    const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim()

    const mentions: Array<{ id: string; name: string }> = []
    const mentionMatches = (event.text || '').matchAll(/<@([A-Z0-9]+)>/g)
    for (const m of mentionMatches) {
      mentions.push({ id: m[1], name: m[1] })
    }

    const links = this.extractLinks(event.text || '')

    let senderName = event.user || 'unknown'
    try {
      const userInfo = await this.app.client.users.info({ user: event.user })
      senderName = userInfo.user?.real_name || userInfo.user?.name || event.user || 'unknown'
    } catch {
      // Use raw user ID as fallback
    }

    return {
      chatId: event.channel,
      messageId: event.ts || '',
      senderId: event.user || '',
      senderName,
      text,
      mentions,
      attachments: [],
      links,
    }
  }

  private extractLinks(text: string): ExtractedLink[] {
    const links: ExtractedLink[] = []
    const seen = new Set<string>()

    // Slack wraps URLs in <url|text> format
    const urlPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g
    let match: RegExpExecArray | null
    while ((match = urlPattern.exec(text)) !== null) {
      const url = match[1]
      if (seen.has(url)) continue
      seen.add(url)

      if (url.includes('atlassian.net/browse/')) {
        const key = url.match(/\/browse\/([A-Z]+-\d+)/)?.[1]
        links.push({ url, type: 'jira', key })
      } else if (url.includes('figma.com/')) {
        links.push({ url, type: 'figma' })
      } else if (url.includes('github.com/')) {
        links.push({ url, type: 'github' })
      } else if (url.includes('/-/issues/') || url.includes('/-/merge_requests/')) {
        links.push({ url, type: 'gitlab' })
      } else {
        links.push({ url, type: 'other' })
      }
    }

    return links
  }
}

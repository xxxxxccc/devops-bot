/**
 * Feishu Message Parser
 *
 * Extracts text, downloads attachments, and detects links from Feishu messages.
 * This is the critical layer that ensures Layer 2 (Task AI) receives complete context.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as lark from '@larksuiteoapi/node-sdk'
import type { Attachment, ExtractedLink, Mention, ParsedMessage } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ATTACHMENTS_DIR = join(__dirname, '..', '..', '..', 'data', 'attachments')

// Ensure attachments directory exists
if (!existsSync(ATTACHMENTS_DIR)) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
}

export class FeishuMessageParser {
  /** Cache open_id -> display name to avoid repeated API calls */
  private nameCache = new Map<string, string>()

  constructor(private client: lark.Client) {}

  /**
   * Parse a Feishu message event into a structured ParsedMessage.
   * Downloads attachments and extracts links.
   */
  async parse(eventData: any): Promise<ParsedMessage> {
    const { message, sender } = eventData
    const openId: string = sender?.sender_id?.open_id || 'unknown'

    // 1. Resolve sender name via contacts API
    const senderName = await this.resolveSenderName(openId)

    // 2. Extract text content
    const text = this.extractText(message)

    // 3. Download attachments (images, files)
    const attachments = await this.downloadAttachments(message)

    // 4. Extract @mentions
    const mentions = this.extractMentions(message)

    // 5. Extract links from text
    const links = this.extractLinks(text)

    return {
      text,
      sender: { name: senderName, openId },
      chatId: message.chat_id,
      messageId: message.message_id,
      mentions,
      attachments,
      links,
    }
  }

  /**
   * Get user display name via Feishu contacts API.
   * Required permission: contact:user.base:readonly
   */
  private async resolveSenderName(openId: string): Promise<string> {
    if (openId === 'unknown') return 'Unknown'
    if (this.nameCache.has(openId)) {
      return this.nameCache.get(openId)!
    }
    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })
      const name = (resp.data?.user as any)?.name
      if (name) {
        this.nameCache.set(openId, name)
        return name
      }
    } catch (err) {
      console.warn(`[Feishu Parser] Failed to resolve name for ${openId}:`, err)
    }
    // Fallback: derive a stable short ID from open_id to keep context consistent
    const shortId = openId.replace(/^ou_/, '').slice(0, 8)
    const fallback = `user-${shortId}`
    this.nameCache.set(openId, fallback)
    return fallback
  }

  /**
   * Extract plain text from various Feishu message types.
   */
  private extractText(message: any): string {
    try {
      const content = JSON.parse(message.content || '{}')
      const messageType: string = message.message_type

      switch (messageType) {
        case 'text':
          return content.text || ''

        case 'post': {
          // Rich text: extract all text elements
          const parts: string[] = []
          const zhContent = content.zh_cn || content.en_us || content
          if (zhContent?.title) parts.push(zhContent.title)
          if (zhContent?.content && Array.isArray(zhContent.content)) {
            for (const paragraph of zhContent.content) {
              if (Array.isArray(paragraph)) {
                for (const element of paragraph) {
                  if (element.tag === 'text') parts.push(element.text || '')
                  if (element.tag === 'a') parts.push(element.text || element.href || '')
                  if (element.tag === 'at')
                    parts.push(`@${element.user_name || element.user_id || ''}`)
                }
              }
            }
          }
          return parts.join(' ').trim()
        }

        case 'image':
          return '[Image]'

        case 'file':
          return `[File: ${content.file_name || 'unknown'}]`

        default:
          return `[${messageType}]`
      }
    } catch {
      return ''
    }
  }

  /**
   * Download attachments (images, files) from a Feishu message to local disk.
   */
  private async downloadAttachments(message: any): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    const messageType: string = message.message_type

    try {
      if (messageType === 'image') {
        const content = JSON.parse(message.content || '{}')
        const imageKey = content.image_key
        if (imageKey) {
          const att = await this.downloadResource(message.message_id, imageKey, 'image', 'png')
          if (att) attachments.push(att)
        }
      }

      if (messageType === 'file') {
        const content = JSON.parse(message.content || '{}')
        const fileKey = content.file_key
        const fileName = content.file_name || 'unknown'
        if (fileKey) {
          const ext = fileName.split('.').pop() || 'bin'
          const att = await this.downloadResource(message.message_id, fileKey, 'file', ext)
          if (att) {
            att.originalname = fileName
            attachments.push(att)
          }
        }
      }

      // For rich text (post), scan for inline images
      if (messageType === 'post') {
        const content = JSON.parse(message.content || '{}')
        const zhContent = content.zh_cn || content.en_us || content
        if (zhContent?.content && Array.isArray(zhContent.content)) {
          for (const paragraph of zhContent.content) {
            if (Array.isArray(paragraph)) {
              for (const element of paragraph) {
                if (element.tag === 'img' && element.image_key) {
                  const att = await this.downloadResource(
                    message.message_id,
                    element.image_key,
                    'image',
                    'png',
                  )
                  if (att) attachments.push(att)
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[Feishu Parser] Error downloading attachments:', err)
    }

    return attachments
  }

  /**
   * Download a single resource (image or file) from Feishu and save to disk.
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    ext: string,
  ): Promise<Attachment | null> {
    try {
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })

      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
      const filePath = join(ATTACHMENTS_DIR, filename)

      // Write response data to file
      const data = resp as any
      if (data && typeof data.pipe === 'function') {
        // Stream response
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(filePath)
          data.pipe(ws)
          ws.on('finish', resolve)
          ws.on('error', reject)
        })
      } else if (data?.writeFile) {
        await data.writeFile(filePath)
      } else {
        console.warn('[Feishu Parser] Unexpected response format for resource download')
        return null
      }

      return {
        filename,
        originalname: filename,
        path: filePath,
        mimetype: type === 'image' ? `image/${ext}` : FeishuMessageParser.inferMimetype(ext),
      }
    } catch (err) {
      console.error(`[Feishu Parser] Failed to download resource ${fileKey}:`, err)
      return null
    }
  }

  /**
   * Extract @mentions from a Feishu message event.
   * Each mention entry maps a placeholder key (e.g. "@_user_1") to a user.
   */
  private extractMentions(message: any): Mention[] {
    const mentions: Mention[] = []
    if (!Array.isArray(message.mentions)) return mentions
    for (const m of message.mentions) {
      mentions.push({
        key: m.key || '',
        openId: m.id?.open_id || '',
        name: m.name || '',
      })
    }
    return mentions
  }

  /**
   * Detect Jira, Figma, GitHub, GitLab links in text.
   */
  extractLinks(text: string): ExtractedLink[] {
    const links: ExtractedLink[] = []
    const seen = new Set<string>()

    // Jira URL: https://xxx.atlassian.net/browse/PROJ-123
    const jiraUrlPattern = /https?:\/\/[^\s]+\.atlassian\.net\/browse\/([A-Z]+-\d+)/gi
    let match: RegExpExecArray | null
    while ((match = jiraUrlPattern.exec(text)) !== null) {
      if (!seen.has(match[0])) {
        seen.add(match[0])
        links.push({ url: match[0], type: 'jira', key: match[1].toUpperCase() })
      }
    }

    // Standalone Jira key: PROJ-123 (only if not already captured as URL)
    const jiraKeyPattern = /(?<!\w)([A-Z]{2,}-\d+)(?!\w)/g
    while ((match = jiraKeyPattern.exec(text)) !== null) {
      const key = match[1]
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ url: '', type: 'jira', key })
      }
    }

    // Figma: https://figma.com/design/xxx/...
    const figmaPattern = /https?:\/\/(www\.)?figma\.com\/(design|file|proto)\/[^\s]+/gi
    while ((match = figmaPattern.exec(text)) !== null) {
      if (!seen.has(match[0])) {
        seen.add(match[0])
        links.push({ url: match[0], type: 'figma' })
      }
    }

    // GitHub: https://github.com/xxx/...
    const githubPattern = /https?:\/\/github\.com\/[^\s]+/gi
    while ((match = githubPattern.exec(text)) !== null) {
      if (!seen.has(match[0])) {
        seen.add(match[0])
        links.push({ url: match[0], type: 'github' })
      }
    }

    // GitLab: https://xxx.com/xxx (common self-hosted pattern)
    const gitlabPattern = /https?:\/\/[^\s]+\/[^\s]+\/-\/(issues|merge_requests)\/\d+/gi
    while ((match = gitlabPattern.exec(text)) !== null) {
      if (!seen.has(match[0])) {
        seen.add(match[0])
        links.push({ url: match[0], type: 'gitlab' })
      }
    }

    return links
  }

  /**
   * Infer MIME type from file extension for non-image files.
   */
  static inferMimetype(ext: string): string {
    const map: Record<string, string> = {
      // Text / markup
      html: 'text/html',
      htm: 'text/html',
      css: 'text/css',
      csv: 'text/csv',
      txt: 'text/plain',
      md: 'text/markdown',
      xml: 'text/xml',
      svg: 'image/svg+xml',
      // Code
      js: 'text/javascript',
      ts: 'text/typescript',
      jsx: 'text/javascript',
      tsx: 'text/typescript',
      json: 'application/json',
      yaml: 'text/yaml',
      yml: 'text/yaml',
      // Documents
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // Archives
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip',
      // Video
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
    }
    return map[ext.toLowerCase()] || 'application/octet-stream'
  }
}

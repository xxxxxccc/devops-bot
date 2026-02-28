/**
 * IM Platform abstraction types.
 *
 * All platform-specific adapters (Feishu, Slack, etc.) implement
 * the IMPlatform interface. Consumers operate on these neutral types.
 */

/* ------------------------------------------------------------------ */
/*  Attachment & Link types (shared with existing codebase)            */
/* ------------------------------------------------------------------ */

export interface Attachment {
  filename: string
  originalname: string
  path: string
  mimetype: string
}

export interface ExtractedLink {
  url: string
  type: 'jira' | 'figma' | 'github' | 'gitlab' | 'other'
  key?: string
}

/* ------------------------------------------------------------------ */
/*  Unified message type                                               */
/* ------------------------------------------------------------------ */

export interface IMMessage {
  chatId: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  mentions?: Array<{ id: string; name: string }>
  attachments: Attachment[]
  links: ExtractedLink[]
}

/* ------------------------------------------------------------------ */
/*  Card (rich message) type                                           */
/* ------------------------------------------------------------------ */

export interface IMCard {
  markdown: string
  header?: { title: string; color?: string }
}

/* ------------------------------------------------------------------ */
/*  Platform interface                                                 */
/* ------------------------------------------------------------------ */

export type IMPlatformType = 'feishu' | 'slack'

export interface IMPlatform {
  readonly id: IMPlatformType

  /**
   * Connect to the IM platform and start receiving messages.
   * The handler is called for every incoming message directed at the bot.
   * The onPassiveMessage handler is called for group messages NOT directed at the bot
   * (useful for conversation history recording).
   */
  connect(options: {
    onMessage: (msg: IMMessage) => Promise<void>
    onPassiveMessage?: (msg: IMMessage) => Promise<void>
  }): Promise<void>

  /** Send plain text to a chat */
  sendText(chatId: string, text: string): Promise<void>

  /** Send a rich card message. Returns the message ID for later updates. */
  sendCard(chatId: string, card: IMCard): Promise<string | undefined>

  /** Update an existing card message in-place */
  updateCard(messageId: string, card: IMCard): Promise<boolean>

  /** Download an attachment from the platform */
  downloadAttachment(attachment: Attachment): Promise<{ data: Buffer; filename: string }>

  /** Get the bot's own user ID */
  getBotId(): string
}

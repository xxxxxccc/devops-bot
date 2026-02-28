/**
 * Feishu (Lark) bot type definitions
 */

/** Configuration for the Feishu bot */
export interface FeishuConfig {
  appId: string
  appSecret: string
}

/** A mention extracted from a Feishu message */
export interface Mention {
  /** Placeholder key in content, e.g. "@_user_1" */
  key: string
  /** User's open_id */
  openId: string
  /** Display name */
  name: string
}

/** A fully parsed Feishu message ready for dispatching */
export interface ParsedMessage {
  /** Clean text content */
  text: string
  /** Sender information */
  sender: {
    /** Display name resolved via contacts API */
    name: string
    /** Feishu open_id */
    openId: string
  }
  /** Feishu chat ID */
  chatId: string
  /** Feishu message ID */
  messageId: string
  /** @mentions in the message */
  mentions: Mention[]
  /** Downloaded attachments (images, files) */
  attachments: Attachment[]
  /** Detected URLs (Jira, Figma, GitHub, etc.) */
  links: ExtractedLink[]
}

/** A downloaded attachment from a Feishu message */
export interface Attachment {
  /** Generated filename on disk */
  filename: string
  /** Original filename from user */
  originalname: string
  /** Local file path after download */
  path: string
  /** MIME type */
  mimetype: string
}

/** A detected link extracted from message text */
export interface ExtractedLink {
  /** The full URL */
  url: string
  /** Detected link type */
  type: 'jira' | 'figma' | 'github' | 'gitlab' | 'other'
  /** Optional key (e.g., PROJ-123 for Jira) */
  key?: string
}

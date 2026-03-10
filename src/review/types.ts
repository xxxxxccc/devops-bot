/**
 * PR Review types — shared across the review module.
 */

export interface ReviewRequest {
  owner: string
  repo: string
  prNumber: number
  host?: string
  projectPath: string
  /** When set, IM notification is sent to this chat after review completes. */
  imChatId?: string
  /** Source that triggered this review. */
  trigger: 'self-review' | 'im-command' | 'poller' | 'webhook'
  /** Output language for review summary and comments (e.g. 'zh-CN', 'en'). */
  language?: string
  /** User instructions from IM chat (e.g. "focus on security and error handling"). */
  userInstructions?: string
}

export interface LineComment {
  path: string
  line: number
  body: string
  severity: 'critical' | 'warning' | 'suggestion' | 'nitpick'
}

export interface FileReview {
  filename: string
  status: string
  additions: number
  deletions: number
  comments: LineComment[]
}

export interface ReviewResult {
  prNumber: number
  owner: string
  repo: string
  summary: string
  overallVerdict: 'approve' | 'request_changes' | 'comment'
  fileReviews: FileReview[]
  /** All line-level comments flattened. */
  lineComments: LineComment[]
  /** GitHub review ID if submitted. */
  reviewId?: number
  /** Head branch name of the PR (for auto-fix checkout). */
  prBranch?: string
  /** Stats */
  stats: {
    filesReviewed: number
    filesSkipped: number
    totalComments: number
    critical: number
    warnings: number
  }
}

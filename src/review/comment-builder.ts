/**
 * Comment Builder — transforms AI review output into GitHub Review API format.
 */

import type { LineComment, ReviewResult } from './types.js'

/**
 * Map the AI verdict to a GitHub review event.
 */
export function toGitHubEvent(
  verdict: ReviewResult['overallVerdict'],
): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  switch (verdict) {
    case 'approve':
      return 'APPROVE'
    case 'request_changes':
      return 'REQUEST_CHANGES'
    default:
      return 'COMMENT'
  }
}

/**
 * Build a markdown summary body for the PR review.
 */
export function buildSummaryBody(result: ReviewResult): string {
  const parts: string[] = [`## AI Code Review Summary`, '', result.summary, '']

  if (result.stats.totalComments > 0) {
    parts.push('### Findings', '')
    if (result.stats.critical > 0) {
      parts.push(`- 🔴 **Critical**: ${result.stats.critical}`)
    }
    if (result.stats.warnings > 0) {
      parts.push(`- 🟡 **Warning**: ${result.stats.warnings}`)
    }
    const suggestions = result.stats.totalComments - result.stats.critical - result.stats.warnings
    if (suggestions > 0) {
      parts.push(`- 💡 **Suggestion/Nitpick**: ${suggestions}`)
    }
    parts.push('')
  }

  parts.push(`📊 Reviewed ${result.stats.filesReviewed} file(s)`)
  if (result.stats.filesSkipped > 0) {
    parts.push(`⏭️ Skipped ${result.stats.filesSkipped} file(s) (generated/lock files)`)
  }

  return parts.join('\n')
}

/**
 * Build GitHub review comment objects from LineComments.
 * Adds severity emoji prefix to each comment body.
 */
export function buildGitHubComments(
  comments: LineComment[],
): Array<{ path: string; line: number; body: string }> {
  return comments.map((c) => ({
    path: c.path,
    line: c.line,
    body: `${severityEmoji(c.severity)} **${c.severity}**: ${c.body}`,
  }))
}

function severityEmoji(severity: LineComment['severity']): string {
  switch (severity) {
    case 'critical':
      return '🔴'
    case 'warning':
      return '🟡'
    case 'suggestion':
      return '💡'
    case 'nitpick':
      return '📝'
  }
}

/**
 * Build an IM card body for review notification.
 */
export function buildIMCardBody(result: ReviewResult, prUrl: string): string {
  const verdict =
    result.overallVerdict === 'approve'
      ? '✅ Approved'
      : result.overallVerdict === 'request_changes'
        ? '❌ Changes Requested'
        : '💬 Commented'

  const parts = [
    `**PR Review**: ${verdict}`,
    '',
    result.summary,
    '',
    `📊 ${result.stats.filesReviewed} files reviewed, ${result.stats.totalComments} comments`,
  ]

  if (result.stats.critical > 0) {
    parts.push(`🔴 ${result.stats.critical} critical issue(s)`)
  }

  parts.push('', `[View PR](${prUrl})`)

  return parts.join('\n')
}

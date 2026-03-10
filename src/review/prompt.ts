/**
 * Review Prompt — system and user prompt builders for the PR review AI.
 *
 * Review comments are restructured as threaded conversations so the AI
 * can see what the author addressed, disputed, or left unresolved.
 */

import type { DiffChunk } from './diff-parser.js'

/* ------------------------------------------------------------------ */
/*  Review comment threading                                           */
/* ------------------------------------------------------------------ */

export interface ReviewComment {
  id: number
  path: string
  line: number | null
  body: string
  user: string
  inReplyToId: number | null
  createdAt: string
}

export type ThreadStatus = 'open' | 'disputed' | 'resolved'

export interface ReviewThread {
  rootComment: ReviewComment
  replies: ReviewComment[]
  status: ThreadStatus
}

const RESOLVED_PATTERNS = /\b(fixed|done|addressed|applied|updated|resolved)\b/i

function isBot(user: string): boolean {
  return user.endsWith('[bot]') || user.endsWith('-bot')
}

/**
 * Group flat review comments into threaded conversations and classify each.
 *
 * - Root comments (inReplyToId === null) that came from a bot start a thread
 * - Human replies to those roots are attached
 * - Threads are classified: resolved (author said "fixed"), disputed
 *   (author replied without "fixed"), or open (no author reply)
 */
export function buildReviewThreads(comments: ReviewComment[]): {
  threads: ReviewThread[]
  otherComments: ReviewComment[]
} {
  const rootMap = new Map<number, ReviewComment>()
  const repliesByRoot = new Map<number, ReviewComment[]>()
  const otherComments: ReviewComment[] = []

  for (const c of comments) {
    if (c.inReplyToId === null) {
      rootMap.set(c.id, c)
    }
  }

  for (const c of comments) {
    if (c.inReplyToId !== null && rootMap.has(c.inReplyToId)) {
      const arr = repliesByRoot.get(c.inReplyToId) ?? []
      arr.push(c)
      repliesByRoot.set(c.inReplyToId, arr)
    } else if (c.inReplyToId !== null && !rootMap.has(c.inReplyToId)) {
      otherComments.push(c)
    }
  }

  const threads: ReviewThread[] = []

  for (const [rootId, root] of rootMap) {
    if (!isBot(root.user)) {
      otherComments.push(root)
      const orphanReplies = repliesByRoot.get(rootId) ?? []
      otherComments.push(...orphanReplies)
      continue
    }

    const replies = repliesByRoot.get(rootId) ?? []
    const authorReplies = replies.filter((r) => !isBot(r.user))

    let status: ThreadStatus = 'open'
    if (authorReplies.length > 0) {
      const hasResolved = authorReplies.some((r) => RESOLVED_PATTERNS.test(r.body))
      status = hasResolved ? 'resolved' : 'disputed'
    }

    threads.push({ rootComment: root, replies, status })
  }

  const statusOrder: Record<ThreadStatus, number> = { open: 0, disputed: 1, resolved: 2 }
  threads.sort((a, b) => {
    const so = statusOrder[a.status] - statusOrder[b.status]
    if (so !== 0) return so
    return b.rootComment.createdAt.localeCompare(a.rootComment.createdAt)
  })

  return { threads, otherComments }
}

/* ------------------------------------------------------------------ */
/*  Budget-aware thread rendering                                      */
/* ------------------------------------------------------------------ */

const MAX_REVIEW_CONTEXT_CHARS = 8_000
const MAX_COMMENT_BODY_CHARS = 400
const MAX_OVERALL_PROMPT_CHARS = 120_000

function truncBody(body: string, max = MAX_COMMENT_BODY_CHARS): string {
  return body.length > max ? `${body.slice(0, max)}...` : body
}

function renderThreads(threads: ReviewThread[], budget: number): string {
  if (threads.length === 0) return ''

  const lines: string[] = [
    '',
    '### Previous Review Discussions',
    '',
    "Each thread shows a bot review comment and the author's reply.",
    '- **[RESOLVED]**: Author confirmed they fixed the issue — do NOT re-raise.',
    '- **[DISPUTED]**: Author disagreed or explained — only re-raise if you have new evidence from the current diff.',
    '- **[OPEN]**: No author reply yet — re-raise if still present in the current diff.',
    '',
  ]

  let used = lines.join('\n').length
  let omittedCount = 0

  for (const t of threads) {
    const loc = t.rootComment.line
      ? `${t.rootComment.path}:${t.rootComment.line}`
      : t.rootComment.path
    const tag = `[${t.status.toUpperCase()}]`

    const threadLines = [`**${tag}** \`${loc}\``, `> **Bot**: ${truncBody(t.rootComment.body)}`]

    for (const r of t.replies.filter((r) => !isBot(r.user))) {
      threadLines.push(`> **${r.user}**: ${truncBody(r.body)}`)
    }
    threadLines.push('')

    const blockSize = threadLines.join('\n').length
    if (used + blockSize > budget) {
      omittedCount++
      continue
    }
    used += blockSize
    lines.push(...threadLines)
  }

  if (omittedCount > 0) {
    lines.push(`*... ${omittedCount} more resolved/older threads omitted for brevity.*`, '')
  }

  return lines.join('\n')
}

function renderOtherComments(comments: ReviewComment[], remainingBudget: number): string {
  if (comments.length === 0) return ''

  const humanComments = comments.filter((c) => !isBot(c.user))
  if (humanComments.length === 0) return ''

  const lines: string[] = ['', '### Other Reviewer Comments (for context)', '']
  let used = lines.join('\n').length

  for (const c of humanComments.slice(0, 15)) {
    const loc = c.line ? `${c.path}:${c.line}` : c.path
    const entry = `- [${c.user}] \`${loc}\`: ${truncBody(c.body, 200)}`
    if (used + entry.length > remainingBudget) break
    used += entry.length + 1
    lines.push(entry)
  }

  return lines.join('\n')
}

export function buildReviewSystemPrompt(params: {
  projectRules?: string
  skillContent?: string
  reviewPatterns?: string
  language?: string
}): string {
  const sections: string[] = [
    '# Code Review Expert',
    '',
    'You are an expert code reviewer. Your job is to review pull request changes and provide actionable, specific feedback.',
    '',
    '## Review Dimensions',
    '',
    '1. **Correctness**: Logic errors, edge cases, off-by-one errors, null/undefined handling',
    '2. **Security**: Injection vulnerabilities, exposed secrets, unsafe operations, auth gaps',
    '3. **Performance**: N+1 queries, unnecessary allocations, missing indexes, blocking operations',
    '4. **Maintainability**: Code clarity, naming, DRY violations, overly complex logic',
    '5. **Error Handling**: Missing try/catch, unhandled promise rejections, unclear error messages',
    '6. **API Design**: Breaking changes, inconsistent interfaces, missing validation',
    '',
    '## Review Guidelines',
    '',
    '- Focus on substantive issues, not style nitpicks (formatters handle that)',
    '- Be specific: reference exact lines and explain WHY something is a problem',
    '- Suggest fixes when possible, not just point out problems',
    '- Acknowledge good patterns when you see them',
    '- Consider the context: a prototype has different standards than production code',
    '- If a file is truncated, note what you can review and flag potential concerns in unseen code',
  ]

  if (params.projectRules) {
    sections.push('', '## Project-Specific Rules', '', params.projectRules)
  }

  if (params.skillContent) {
    sections.push('', '## Review Standards (from Skill)', '', params.skillContent)
  }

  if (params.reviewPatterns) {
    sections.push('', '## Past Review Patterns (from Memory)', '', params.reviewPatterns)
  }

  if (params.language) {
    sections.push(
      '',
      '## Output Language',
      '',
      `Write the "summary" and all comment "body" fields in **${params.language}**.`,
      'Keep file paths, code snippets, and JSON keys in English.',
    )
  }

  sections.push(
    '',
    '## Output Format',
    '',
    'Respond with ONLY a valid JSON object (no markdown fences, no prose before/after):',
    '{',
    '  "summary": "1-3 sentence overall assessment of the PR",',
    '  "verdict": "approve | request_changes | comment",',
    '  "comments": [',
    '    {',
    '      "path": "relative/file/path",',
    '      "line": 42,',
    '      "body": "Specific feedback with suggested fix if applicable",',
    '      "severity": "critical | warning | suggestion | nitpick"',
    '    }',
    '  ]',
    '}',
    '',
    'verdict rules:',
    '- "approve": No critical or warning issues found',
    '- "request_changes": At least one critical issue that must be fixed',
    '- "comment": Warnings or suggestions but no blockers',
  )

  return sections.join('\n')
}

export interface PRDiscussionContext {
  issueComments: Array<{ user: string; body: string; createdAt: string }>
  reviewSummaries: Array<{ user: string; body: string; state: string; createdAt: string }>
}

export function buildReviewUserPrompt(params: {
  prTitle: string
  prBody: string
  chunks: DiffChunk[]
  reviewComments?: ReviewComment[]
  discussion?: PRDiscussionContext
  userInstructions?: string
}): string {
  const parts: string[] = [`## Pull Request: ${params.prTitle}`]

  if (params.userInstructions) {
    parts.push(
      '',
      '### Reviewer Instructions (from the user who requested this review)',
      '',
      params.userInstructions,
    )
  }

  if (params.prBody) {
    const body =
      params.prBody.length > 2000 ? `${params.prBody.slice(0, 2000)}... [truncated]` : params.prBody
    parts.push('', '### Description', '', body)
  }

  if (params.discussion) {
    const { issueComments, reviewSummaries } = params.discussion
    const hasDiscussion = issueComments.length > 0 || reviewSummaries.length > 0
    if (hasDiscussion) {
      parts.push('', '### PR Discussion Context (consider these opinions)', '')
      for (const r of reviewSummaries.slice(0, 10)) {
        if (!r.body) continue
        parts.push(`- [${r.user}] (review: ${r.state}) ${r.body.slice(0, 300)}`)
      }
      for (const c of issueComments.slice(0, 15)) {
        parts.push(`- [${c.user}] ${c.body.slice(0, 300)}`)
      }
    }
  }

  // Threaded review comments (replaces flat "do not duplicate" list)
  if (params.reviewComments && params.reviewComments.length > 0) {
    const { threads, otherComments } = buildReviewThreads(params.reviewComments)
    const threadBlock = renderThreads(threads, MAX_REVIEW_CONTEXT_CHARS)
    if (threadBlock) parts.push(threadBlock)

    const remaining = MAX_REVIEW_CONTEXT_CHARS - threadBlock.length
    const otherBlock = renderOtherComments(otherComments, Math.max(remaining, 1000))
    if (otherBlock) parts.push(otherBlock)
  }

  // Changed files — may be trimmed if overall prompt is too large
  parts.push('', '### Changed Files', '')

  const chunkBudget = MAX_OVERALL_PROMPT_CHARS - parts.join('\n').length
  let chunkUsed = 0
  const includedChunks: string[] = []
  let trimmedCount = 0

  for (const chunk of params.chunks) {
    const block = [
      `#### ${chunk.filename} (${chunk.language}, +${chunk.additions}/-${chunk.deletions}, ${chunk.status})`,
      '',
      '```diff',
      chunk.patch,
      '```',
      '',
    ].join('\n')

    if (chunkUsed + block.length > chunkBudget && includedChunks.length > 0) {
      trimmedCount++
      continue
    }
    chunkUsed += block.length
    includedChunks.push(block)
  }

  parts.push(...includedChunks)

  if (trimmedCount > 0) {
    parts.push(
      `*... ${trimmedCount} more file(s) omitted to stay within context limits. Review the included files thoroughly.*`,
      '',
    )
  }

  return parts.join('\n')
}

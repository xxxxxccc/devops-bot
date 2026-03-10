/**
 * Review AI Client — calls the AI model to analyze PR diffs.
 *
 * Reuses the project's provider system (TASK_MODEL by default).
 * Parses structured JSON output into ReviewResult.
 */

import { createLogger } from '../infra/logger.js'
import { createProviderFromEnv } from '../providers/index.js'
import type { AIProvider } from '../providers/types.js'
import type { DiffChunk } from './diff-parser.js'
import {
  type PRDiscussionContext,
  type ReviewComment,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
} from './prompt.js'
import type { LineComment, ReviewResult } from './types.js'

const log = createLogger('review-ai')

const REVIEW_MODEL =
  process.env.REVIEW_MODEL || process.env.TASK_MODEL || 'claude-opus-4-5-20251101'

interface AIReviewOutput {
  summary: string
  verdict: 'approve' | 'request_changes' | 'comment'
  comments: Array<{
    path: string
    line: number
    body: string
    severity: 'critical' | 'warning' | 'suggestion' | 'nitpick'
  }>
}

export async function reviewWithAI(params: {
  prTitle: string
  prBody: string
  chunks: DiffChunk[]
  skippedFiles: string[]
  totalFiles: number
  reviewComments?: ReviewComment[]
  discussion?: PRDiscussionContext
  projectRules?: string
  skillContent?: string
  reviewPatterns?: string
  language?: string
  userInstructions?: string
}): Promise<ReviewResult> {
  const provider = await getProvider()

  const systemPrompt = buildReviewSystemPrompt({
    projectRules: params.projectRules,
    skillContent: params.skillContent,
    reviewPatterns: params.reviewPatterns,
    language: params.language,
  })

  const userPrompt = buildReviewUserPrompt({
    prTitle: params.prTitle,
    prBody: params.prBody,
    chunks: params.chunks,
    reviewComments: params.reviewComments,
    discussion: params.discussion,
    userInstructions: params.userInstructions,
  })

  log.info('Calling review AI', {
    model: REVIEW_MODEL,
    files: params.chunks.length,
    promptChars: userPrompt.length,
  })

  const response = await provider.createMessage({
    model: REVIEW_MODEL,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 8192,
    temperature: 0.2,
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')

  const parsed = parseAIOutput(text)

  const lineComments: LineComment[] = parsed.comments.map((c) => ({
    path: c.path,
    line: c.line,
    body: c.body,
    severity: c.severity,
  }))

  const critical = lineComments.filter((c) => c.severity === 'critical').length
  const warnings = lineComments.filter((c) => c.severity === 'warning').length

  return {
    prNumber: 0,
    owner: '',
    repo: '',
    summary: parsed.summary,
    overallVerdict: parsed.verdict,
    fileReviews: [],
    lineComments,
    stats: {
      filesReviewed: params.chunks.length,
      filesSkipped: params.skippedFiles.length,
      totalComments: lineComments.length,
      critical,
      warnings,
    },
  }
}

function parseAIOutput(text: string): AIReviewOutput {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned) as AIReviewOutput
    return {
      summary: parsed.summary || 'No summary provided.',
      verdict: normalizeVerdict(parsed.verdict),
      comments: Array.isArray(parsed.comments)
        ? parsed.comments.filter((c) => c.path && typeof c.line === 'number' && c.body)
        : [],
    }
  } catch (err) {
    log.warn('Failed to parse AI review output, treating as comment', {
      error: err instanceof Error ? err.message : String(err),
      text: cleaned.slice(0, 500),
    })
    return {
      summary: cleaned.slice(0, 500) || 'Review completed but output could not be parsed.',
      verdict: 'comment',
      comments: [],
    }
  }
}

function normalizeVerdict(v: string | undefined): 'approve' | 'request_changes' | 'comment' {
  if (v === 'approve' || v === 'request_changes' || v === 'comment') return v
  return 'comment'
}

let _provider: AIProvider | null = null

async function getProvider(): Promise<AIProvider> {
  if (!_provider) {
    _provider = await createProviderFromEnv()
  }
  return _provider
}

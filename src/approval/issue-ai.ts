/**
 * Issue AI — lightweight AI that reads a full issue context and synthesizes
 * a clear, actionable task description for the Task AI executor.
 *
 * Uses the Dispatcher model (Sonnet) for cost efficiency. No tools needed —
 * single prompt to structured JSON response.
 */

import { createLogger } from '../infra/logger.js'
import { retry } from '../infra/retry.js'
import type { AIProvider } from '../providers/types.js'
import { createProviderFromEnv } from '../providers/index.js'

const log = createLogger('issue-ai')

const ISSUE_AI_MODEL =
  process.env.ISSUE_AI_MODEL || process.env.DISPATCHER_MODEL || 'claude-sonnet-4-5-20250929'

export interface IssueContext {
  title: string
  body: string
  labels: string[]
  comments: Array<{ user: string; body: string; createdAt: string }>
  repoOwner: string
  repoName: string
  issueNumber: number
  issueUrl: string
}

export interface SynthesizedTask {
  title: string
  description: string
  feasible: boolean
  reason?: string
  /** Detected language of the issue discussion (e.g. "zh-CN", "en") */
  language?: string
}

const SYSTEM_PROMPT = [
  'You are an Issue Analyzer for a DevOps automation bot.',
  'Given a GitHub/GitLab issue with its full discussion, synthesize a clear, actionable task description that a code-changing AI agent can execute.',
  '',
  'Output a JSON object with this exact schema:',
  '{',
  '  "title": "concise task title (max 100 chars)",',
  '  "description": "detailed, actionable description",',
  '  "feasible": true or false,',
  '  "reason": "explanation if not feasible",',
  "  \"language\": \"detected language of the issue discussion (e.g. 'zh-CN', 'en', 'ja')\"",
  '}',
  '',
  'Rules for the description:',
  '- Must be self-contained — the executor will NOT see the original issue',
  '- Include: what needs to change, why, any constraints or edge cases from the discussion',
  '- Mention specific files, modules, or APIs if the discussion references them',
  '- Focus on the LATEST consensus — later comments may override earlier requirements',
  '- Filter out meta-discussion (approval requests, status updates, bot-generated content)',
  '- Output title and description in the same language as the majority of the issue discussion',
  '',
  'Set feasible=false when:',
  '- The issue is too vague to produce a specific code change',
  '- It requires human decisions that have not been made in the discussion',
  '- It is not a code/config change (e.g. pure discussion, question, or ops request)',
  '- The discussion shows unresolved disagreement about the approach',
  '',
  'Output ONLY the JSON object, no markdown fences, no explanation.',
].join('\n')

let _provider: AIProvider | null = null

async function getProvider(): Promise<AIProvider> {
  if (!_provider) {
    _provider = await createProviderFromEnv()
  }
  return _provider
}

function buildUserPrompt(ctx: IssueContext): string {
  const parts: string[] = [
    `## Issue #${ctx.issueNumber} in ${ctx.repoOwner}/${ctx.repoName}`,
    '',
    `**Title:** ${ctx.title}`,
  ]

  if (ctx.labels.length > 0) {
    parts.push(`**Labels:** ${ctx.labels.join(', ')}`)
  }

  parts.push('')

  const body = (ctx.body ?? '').trim()
  if (body) {
    parts.push('### Body', '', body)
  } else {
    parts.push('### Body', '', '(empty)')
  }

  if (ctx.comments.length > 0) {
    parts.push('', '### Discussion')
    for (const c of ctx.comments) {
      const text = (c.body ?? '').trim()
      if (text) {
        parts.push('', `**@${c.user}** (${c.createdAt}):`, text)
      }
    }
  }

  return parts.join('\n')
}

export async function synthesizeTask(ctx: IssueContext): Promise<SynthesizedTask> {
  const provider = await getProvider()
  const userPrompt = buildUserPrompt(ctx)

  log.info('Synthesizing task from issue', {
    issueNumber: ctx.issueNumber,
    repo: `${ctx.repoOwner}/${ctx.repoName}`,
    commentCount: ctx.comments.length,
  })

  try {
    const response = await retry(
      () =>
        provider.createMessage({
          model: ISSUE_AI_MODEL,
          maxTokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      {
        maxAttempts: 2,
        onRetry: (_err, attempt, delay) => log.warn(`Issue AI retry ${attempt}`, { delay }),
      },
    )

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')

    const parsed = parseResponse(text)
    if (parsed) {
      log.info('Issue AI synthesized task', {
        issueNumber: ctx.issueNumber,
        feasible: parsed.feasible,
        title: parsed.title.slice(0, 80),
      })
      return parsed
    }

    log.warn('Issue AI returned unparseable response', {
      issueNumber: ctx.issueNumber,
      text: text.slice(0, 500),
    })
    return {
      title: ctx.title,
      description: `Issue #${ctx.issueNumber}: ${ctx.title}\n\n${body(ctx)}`,
      feasible: true,
    }
  } catch (err) {
    log.error('Issue AI call failed, falling back to raw issue content', {
      issueNumber: ctx.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      title: ctx.title,
      description: `Issue #${ctx.issueNumber}: ${ctx.title}\n\n${body(ctx)}`,
      feasible: true,
    }
  }
}

function body(ctx: IssueContext): string {
  return (ctx.body ?? '').trim() || '(no description)'
}

function parseResponse(text: string): SynthesizedTask | null {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()

  try {
    const obj = JSON.parse(cleaned)
    if (typeof obj.title === 'string' && typeof obj.description === 'string') {
      return {
        title: obj.title,
        description: obj.description,
        feasible: obj.feasible !== false,
        reason: obj.reason ?? undefined,
        language: typeof obj.language === 'string' ? obj.language : undefined,
      }
    }
  } catch {
    // Try extracting JSON from text
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1))
        if (typeof obj.title === 'string' && typeof obj.description === 'string') {
          return {
            title: obj.title,
            description: obj.description,
            feasible: obj.feasible !== false,
            reason: obj.reason ?? undefined,
            language: typeof obj.language === 'string' ? obj.language : undefined,
          }
        }
      } catch {
        // give up
      }
    }
  }

  return null
}

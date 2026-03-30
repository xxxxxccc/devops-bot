/**
 * Issue AI — lightweight AI that reads a full issue context and synthesizes
 * a clear, actionable task description for the Task AI executor.
 *
 * Two modes:
 *   1. Single-phase (no workspace): synthesizeTask() — current behavior
 *   2. Two-phase (with workspace):
 *      a. triageIssue() — quality gate + cross-repo routing
 *      b. synthesizeTaskForTarget() — per-repo task content generation
 *
 * Uses the Dispatcher model (Sonnet) for cost efficiency. No tools needed —
 * single prompt to structured JSON response.
 */

import { createLogger } from '../infra/logger.js'
import { retry } from '../infra/retry.js'
import type { AIProvider } from '../providers/types.js'
import { getModelRouter } from '../providers/router.js'

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

/* ================================================================== */
/*  Cross-repo triage types                                            */
/* ================================================================== */

export interface TriageTarget {
  projectId: string
  gitUrl: string
  reason: string
}

export type TriageVerdict = 'actionable' | 'needs_info' | 'reject'

export interface TriageResult {
  verdict: TriageVerdict
  verdictReason: string
  targets: TriageTarget[]
  language?: string
}

export interface WorkspaceContext {
  projects: Array<{ id: string; gitUrl: string; lang?: string; description?: string }>
  architectureDoc: string
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
  '- It is a pure discussion, question, or ops request with no code/file changes possible',
  '- The discussion shows unresolved disagreement about the approach',
  '',
  'Set feasible=true even when:',
  '- The task involves binary files (images, fonts, etc.) — the executor can use shell commands',
  '  (git clone, cp, curl, mv) to fetch and place binary files from external repos or URLs.',
  '- The task requires downloading resources from another repository — the executor has shell access.',
  '- The task mixes binary file operations with code changes (e.g. replace images AND update XML references).',
  '',
  'Output ONLY the JSON object, no markdown fences, no explanation.',
].join('\n')

let _provider: AIProvider | null = null
let _resolvedModel: string = ISSUE_AI_MODEL

async function getProvider(): Promise<AIProvider> {
  if (!_provider) {
    const route = await getModelRouter().resolve(ISSUE_AI_MODEL)
    _provider = route.provider
    _resolvedModel = route.modelId
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
          model: _resolvedModel,
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
  const obj = extractJSON(text)
  if (!obj) return null
  if (typeof obj.title === 'string' && typeof obj.description === 'string') {
    return {
      title: obj.title,
      description: obj.description,
      feasible: obj.feasible !== false,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      language: typeof obj.language === 'string' ? obj.language : undefined,
    }
  }
  return null
}

function extractJSON(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()

  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      } catch {
        /* give up */
      }
    }
  }
  return null
}

/* ================================================================== */
/*  Phase 1: Cross-repo triage (quality gate + repo routing)           */
/* ================================================================== */

const TRIAGE_SYSTEM_PROMPT = [
  'You are an Issue Triage AI for a multi-project workspace.',
  'Given a GitHub issue with its full discussion and a list of workspace projects,',
  'you must make TWO decisions:',
  '',
  '## A. Quality Assessment — is this issue suitable for automated code changes?',
  '',
  'Set verdict to "reject" when:',
  '- The issue body contains specific code-level claims (function behavior, regex patterns,',
  '  implementation details) that read as speculation without evidence of actual code access.',
  '  This is common in bot-generated issues that fabricate detailed "root cause analysis".',
  '- Discussion comments from repo members/maintainers have refuted the analysis.',
  '- The issue is vague, contradictory, or requests investigation rather than a concrete change.',
  '- The suggested fix direction is based on hallucinated code structure.',
  '',
  'Do NOT reject when:',
  '- The task involves binary files (images, fonts, compiled assets, etc.) — the executor has',
  '  shell access and can use git clone, cp, curl, mv to fetch and place binary files.',
  '- The task requires fetching resources from external repos or URLs.',
  '- The task mixes binary file operations with code/config changes.',
  '',
  'Set verdict to "needs_info" when:',
  '- The root cause is plausible but insufficient detail to produce a correct fix.',
  '- Specific data is needed (logs, raw source, reproduction steps) before acting.',
  '',
  'Set verdict to "actionable" when:',
  '- The issue describes a clear, concrete change with reliable context.',
  '- Even if imperfect, there is enough signal for a code-changing AI to attempt a fix.',
  '',
  '## B. Repo Routing (only when verdict is "actionable")',
  '',
  'Determine which project(s) in the workspace should handle this issue.',
  'Use the architecture context (CLAUDE.md) and project descriptions to decide.',
  'An issue filed in a client repo may actually need a server-side fix, or vice versa.',
  'You may return multiple targets when the fix genuinely requires changes in multiple repos.',
  '',
  'CRITICAL: Only use projectId and gitUrl values from the provided project list.',
  'Never invent project names or URLs.',
  '',
  '## Output Format',
  '',
  'Output a JSON object with this exact schema:',
  '{',
  '  "verdict": "actionable" | "needs_info" | "reject",',
  '  "verdictReason": "detailed explanation of your assessment",',
  '  "targets": [{ "projectId": "...", "gitUrl": "...", "reason": "why this repo" }],',
  '  "language": "detected language of the discussion (e.g. \'zh-CN\', \'en\')"',
  '}',
  '',
  'When verdict is NOT "actionable", targets must be an empty array.',
  'verdictReason is ALWAYS required and should be detailed enough to post as an issue comment.',
  'Output the verdictReason in the same language as the majority of the issue discussion.',
  '',
  'Output ONLY the JSON object, no markdown fences, no explanation.',
].join('\n')

function buildTriageUserPrompt(ctx: IssueContext, workspace: WorkspaceContext): string {
  const parts: string[] = [
    `## Issue #${ctx.issueNumber} in ${ctx.repoOwner}/${ctx.repoName}`,
    '',
    `**Title:** ${ctx.title}`,
  ]

  if (ctx.labels.length > 0) {
    parts.push(`**Labels:** ${ctx.labels.join(', ')}`)
  }

  parts.push('')

  const issueBody = (ctx.body ?? '').trim()
  if (issueBody) {
    parts.push('### Body', '', issueBody)
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

  parts.push('', '---', '', '## Workspace Projects', '')
  parts.push('| ID | Language | Description | Git URL |')
  parts.push('|----|----------|-------------|---------|')
  for (const p of workspace.projects) {
    parts.push(`| ${p.id} | ${p.lang ?? '-'} | ${p.description ?? '-'} | ${p.gitUrl} |`)
  }

  if (workspace.architectureDoc) {
    const truncated = workspace.architectureDoc.slice(0, 4000)
    parts.push('', '## Architecture Context (from workspace CLAUDE.md)', '', truncated)
    if (workspace.architectureDoc.length > 4000) {
      parts.push('', '... (truncated)')
    }
  }

  return parts.join('\n')
}

export async function triageIssue(
  ctx: IssueContext,
  workspace: WorkspaceContext,
): Promise<TriageResult> {
  const provider = await getProvider()
  const userPrompt = buildTriageUserPrompt(ctx, workspace)

  log.info('Triaging issue with workspace context', {
    issueNumber: ctx.issueNumber,
    repo: `${ctx.repoOwner}/${ctx.repoName}`,
    projectCount: workspace.projects.length,
  })

  try {
    const response = await retry(
      () =>
        provider.createMessage({
          model: _resolvedModel,
          maxTokens: 2048,
          system: TRIAGE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      {
        maxAttempts: 2,
        onRetry: (_err, attempt, delay) => log.warn(`Triage AI retry ${attempt}`, { delay }),
      },
    )

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')

    const parsed = parseTriageResponse(text, workspace)
    if (parsed) {
      log.info('Triage completed', {
        issueNumber: ctx.issueNumber,
        verdict: parsed.verdict,
        targetCount: parsed.targets.length,
      })
      return parsed
    }

    log.warn('Triage AI returned unparseable response, falling back to single-target', {
      issueNumber: ctx.issueNumber,
      text: text.slice(0, 500),
    })
  } catch (err) {
    log.error('Triage AI call failed, falling back to single-target', {
      issueNumber: ctx.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Fallback: actionable, target the filing repo if it's in the workspace
  const filingProject = workspace.projects.find(
    (p) => p.gitUrl.includes(`${ctx.repoOwner}/${ctx.repoName}`) || p.id === ctx.repoName,
  )
  return {
    verdict: 'actionable',
    verdictReason: 'Triage AI unavailable; defaulting to filing repo.',
    targets: filingProject
      ? [{ projectId: filingProject.id, gitUrl: filingProject.gitUrl, reason: 'filing repo' }]
      : [],
    language: undefined,
  }
}

function parseTriageResponse(text: string, workspace: WorkspaceContext): TriageResult | null {
  const obj = extractJSON(text)
  if (!obj) return null

  const verdict = obj.verdict as string
  if (!['actionable', 'needs_info', 'reject'].includes(verdict)) return null

  const verdictReason = typeof obj.verdictReason === 'string' ? obj.verdictReason : ''

  const rawTargets = Array.isArray(obj.targets) ? obj.targets : []
  const validGitUrls = new Set(workspace.projects.map((p) => p.gitUrl))

  const targets: TriageTarget[] = rawTargets
    .filter(
      (t: any) =>
        typeof t?.projectId === 'string' &&
        typeof t?.gitUrl === 'string' &&
        validGitUrls.has(t.gitUrl),
    )
    .map((t: any) => ({
      projectId: t.projectId as string,
      gitUrl: t.gitUrl as string,
      reason: typeof t.reason === 'string' ? t.reason : '',
    }))

  return {
    verdict: verdict as TriageVerdict,
    verdictReason,
    targets: verdict === 'actionable' ? targets : [],
    language: typeof obj.language === 'string' ? obj.language : undefined,
  }
}

/* ================================================================== */
/*  Phase 2: Per-target task synthesis                                 */
/* ================================================================== */

const TARGET_SYNTHESIS_SYSTEM_PROMPT = [
  'You are an Issue Analyzer for a DevOps automation bot.',
  'You are generating a task description for a SPECIFIC project in a multi-project workspace.',
  '',
  'A triage step has already determined that this project is responsible for the issue.',
  'Your job is to produce a clear, actionable task description that a code-changing AI agent',
  "can execute within this specific project's codebase.",
  '',
  'Output a JSON object with this exact schema:',
  '{',
  '  "title": "concise task title (max 100 chars)",',
  '  "description": "detailed, actionable description for this specific project",',
  '  "feasible": true or false,',
  '  "reason": "explanation if not feasible",',
  "  \"language\": \"detected language of the issue discussion (e.g. 'zh-CN', 'en', 'ja')\"",
  '}',
  '',
  'Rules for the description:',
  '- Must be self-contained — the executor will NOT see the original issue',
  '- Include: what needs to change in THIS project, why, any constraints',
  '- Mention specific files, modules, or APIs if the discussion references them',
  '- Focus on the LATEST consensus — later comments override earlier requirements',
  '- Filter out meta-discussion and unrelated content for other projects',
  '- Output title and description in the same language as the majority of the issue discussion',
  '',
  'Set feasible=false when:',
  '- The issue is too vague to produce a specific code change for this project',
  '- It requires human decisions that have not been made',
  '',
  'Set feasible=true even when:',
  '- The task involves binary files (images, fonts, etc.) — the executor can use shell commands',
  '  (git clone, cp, curl, mv) to fetch and place binary files from external repos or URLs.',
  '',
  'Output ONLY the JSON object, no markdown fences, no explanation.',
].join('\n')

function buildTargetSynthesisUserPrompt(
  ctx: IssueContext,
  target: TriageTarget,
  workspace: WorkspaceContext,
): string {
  const parts: string[] = [
    `## Target Project: ${target.projectId}`,
    `**Git URL:** ${target.gitUrl}`,
    `**Triage Reason:** ${target.reason}`,
    '',
    `## Original Issue #${ctx.issueNumber} in ${ctx.repoOwner}/${ctx.repoName}`,
    '',
    `**Title:** ${ctx.title}`,
  ]

  if (ctx.labels.length > 0) {
    parts.push(`**Labels:** ${ctx.labels.join(', ')}`)
  }

  parts.push('')

  const issueBody = (ctx.body ?? '').trim()
  if (issueBody) {
    parts.push('### Body', '', issueBody)
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

  if (workspace.architectureDoc) {
    const truncated = workspace.architectureDoc.slice(0, 3000)
    parts.push('', '---', '', '## Architecture Context', '', truncated)
    if (workspace.architectureDoc.length > 3000) {
      parts.push('', '... (truncated)')
    }
  }

  return parts.join('\n')
}

export async function synthesizeTaskForTarget(
  ctx: IssueContext,
  target: TriageTarget,
  workspace: WorkspaceContext,
): Promise<SynthesizedTask> {
  const provider = await getProvider()
  const userPrompt = buildTargetSynthesisUserPrompt(ctx, target, workspace)

  log.info('Synthesizing task for target project', {
    issueNumber: ctx.issueNumber,
    targetProject: target.projectId,
  })

  try {
    const response = await retry(
      () =>
        provider.createMessage({
          model: _resolvedModel,
          maxTokens: 2048,
          system: TARGET_SYNTHESIS_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      {
        maxAttempts: 2,
        onRetry: (_err, attempt, delay) =>
          log.warn(`Target synthesis AI retry ${attempt}`, { delay }),
      },
    )

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')

    const parsed = parseResponse(text)
    if (parsed) {
      log.info('Target synthesis completed', {
        issueNumber: ctx.issueNumber,
        targetProject: target.projectId,
        feasible: parsed.feasible,
      })
      return parsed
    }

    log.warn('Target synthesis returned unparseable response', {
      issueNumber: ctx.issueNumber,
      text: text.slice(0, 500),
    })
  } catch (err) {
    log.error('Target synthesis AI call failed', {
      issueNumber: ctx.issueNumber,
      targetProject: target.projectId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    title: ctx.title,
    description: `Issue #${ctx.issueNumber}: ${ctx.title}\n\nTarget project: ${target.projectId}\nReason: ${target.reason}\n\n${body(ctx)}`,
    feasible: true,
  }
}

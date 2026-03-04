/**
 * Review Engine — orchestrates the complete PR review flow.
 *
 * Flow:
 *   1. Fetch PR metadata + files
 *   2. Fetch existing review comments (avoid duplicates)
 *   3. Parse and chunk diffs
 *   4. Load review skills (bundled + workspace)
 *   5. Load target project rules (AGENTS.md / CLAUDE.md)
 *   6. Load review memory patterns
 *   7. Call Review AI (with skills + rules + patterns context)
 *   8. Submit GitHub review (summary + line comments)
 *   9. Write to review memory namespace
 *  10. Return result
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createLogger } from '../infra/logger.js'
import type { GitHubClient } from '../github/client.js'
import type { MemoryStore } from '../memory/store.js'
import type { MemoryRetriever } from '../memory/retriever.js'
import { SkillScanner } from '../prompt/skill-scanner.js'
import { ProjectScanner } from '../prompt/project-scanner.js'
import { parsePRFiles } from './diff-parser.js'
import { reviewWithAI } from './ai-client.js'
import { buildSummaryBody, buildGitHubComments, toGitHubEvent } from './comment-builder.js'
import type { ReviewRequest, ReviewResult } from './types.js'

const log = createLogger('review-engine')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const REVIEW_SKILL_NAMES = new Set(['pr-review', 'code-review-analysis', 'code-review'])
const DEFAULT_WORKSPACE_DIR = join(homedir(), '.devops-bot')

export interface ReviewEngineDeps {
  githubClient: GitHubClient
  memoryStore: MemoryStore | null
  memoryRetriever: MemoryRetriever | null
}

export class ReviewEngine {
  constructor(private deps: ReviewEngineDeps) {}

  async reviewPR(request: ReviewRequest): Promise<ReviewResult> {
    const { owner, repo, prNumber, host = 'github.com', projectPath } = request
    const gh = this.deps.githubClient

    log.info('Starting PR review', { owner, repo, prNumber, trigger: request.trigger })

    // 1. Fetch PR metadata
    const pr = await gh.getPR(owner, repo, prNumber, host)
    if (!pr) {
      throw new Error(`Failed to fetch PR #${prNumber} from ${owner}/${repo}`)
    }

    // 2. Fetch PR files
    const files = await gh.getPRFiles(owner, repo, prNumber, host)
    if (files.length === 0) {
      log.info('PR has no file changes', { prNumber })
      return emptyResult(prNumber, owner, repo)
    }

    // 3. Fetch existing review comments to avoid duplicates
    const existingComments = await gh.listReviewComments(owner, repo, prNumber, host)

    // 3b. Fetch full PR discussion (issue comments + review summaries)
    const discussion = await gh.getPRConversation(owner, repo, prNumber, host)

    // 4. Parse and chunk diffs
    const parsed = parsePRFiles(files)
    if (parsed.chunks.length === 0) {
      log.info('All files skipped (generated/lock files only)', { prNumber })
      return emptyResult(prNumber, owner, repo)
    }

    // 5. Load review skills
    const skillContent = this.loadReviewSkills()

    // 6. Load target project rules (AGENTS.md / CLAUDE.md)
    const projectRules = this.loadProjectRules(projectPath)

    // 7. Load review context from memory
    let reviewPatterns: string | undefined
    if (this.deps.memoryStore && this.deps.memoryRetriever) {
      try {
        const results = await this.deps.memoryStore.searchInNamespace(
          `${pr.title} ${parsed.chunks.map((c) => c.filename).join(' ')}`,
          projectPath,
          'review',
          { limit: 5, minScore: 0.2 },
        )
        if (results.length > 0) {
          reviewPatterns = this.deps.memoryRetriever.formatAsContext(results.map((r) => r.item))
        }
      } catch (err) {
        log.warn('Failed to retrieve review patterns from memory', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 8. Call Review AI
    const result = await reviewWithAI({
      prTitle: pr.title,
      prBody: pr.body,
      chunks: parsed.chunks,
      skippedFiles: parsed.skippedFiles,
      totalFiles: parsed.totalFiles,
      existingComments: existingComments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      })),
      discussion,
      projectRules: projectRules || undefined,
      skillContent: skillContent || undefined,
      reviewPatterns,
    })

    result.prNumber = prNumber
    result.owner = owner
    result.repo = repo
    result.prBranch = pr.head

    // 9. Submit GitHub review
    try {
      const summaryBody = buildSummaryBody(result)
      const ghComments = buildGitHubComments(result.lineComments)

      const review = await gh.createReview(
        owner,
        repo,
        prNumber,
        {
          body: summaryBody,
          event: toGitHubEvent(result.overallVerdict),
          comments: ghComments,
        },
        host,
      )

      if (review) {
        result.reviewId = review.id
        log.info('GitHub review submitted', {
          prNumber,
          reviewId: review.id,
          verdict: result.overallVerdict,
        })
      }
    } catch (err) {
      log.error('Failed to submit GitHub review', {
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 10. Write to review memory
    this.memorizeReview(result, projectPath)

    log.info('PR review complete', {
      prNumber,
      verdict: result.overallVerdict,
      comments: result.stats.totalComments,
    })

    return result
  }

  private loadReviewSkills(): string {
    const bundledRoot = join(__dirname, '..', '..')
    const workspaceDir = process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR
    const scanner = new SkillScanner()
    const skills = scanner.getSkills(bundledRoot, workspaceDir)
    const reviewSkills = skills.filter((s) => REVIEW_SKILL_NAMES.has(s.name))

    if (reviewSkills.length === 0) {
      log.info('No review skills found')
      return ''
    }

    const parts: string[] = []
    for (const skill of reviewSkills) {
      try {
        const content = readFileSync(skill.location, 'utf-8')
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
        if (body) {
          parts.push(`### ${skill.name} (${skill.source})\n\n${body}`)
        }
      } catch {
        log.warn(`Failed to read skill: ${skill.location}`)
      }
    }

    if (parts.length > 0) {
      log.info(
        `Loaded ${parts.length} review skill(s): ${reviewSkills.map((s) => s.name).join(', ')}`,
      )
    }

    return parts.join('\n\n---\n\n')
  }

  private loadProjectRules(projectPath: string): string {
    const scanner = new ProjectScanner()
    return scanner.getProjectRules(projectPath)
  }

  private memorizeReview(result: ReviewResult, projectPath: string): void {
    if (!this.deps.memoryStore) return

    try {
      if (result.summary) {
        this.deps.memoryStore.addItem({
          type: 'review_feedback',
          content: `PR #${result.prNumber} (${result.owner}/${result.repo}): ${result.summary}`,
          source: 'review',
          sourceId: `pr-${result.prNumber}`,
          projectPath,
          namespace: 'review',
        })
      }

      const criticalComments = result.lineComments.filter(
        (c) => c.severity === 'critical' || c.severity === 'warning',
      )
      if (criticalComments.length > 0) {
        const patterns = criticalComments
          .map((c) => `[${c.severity}] ${c.path}: ${c.body}`)
          .join('\n')
        this.deps.memoryStore.addItem({
          type: 'review_pattern',
          content: `Patterns from PR #${result.prNumber}: \n${patterns}`,
          source: 'review',
          sourceId: `pr-${result.prNumber}`,
          projectPath,
          namespace: 'review',
        })
      }
    } catch (err) {
      log.warn('Failed to memorize review', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function emptyResult(prNumber: number, owner: string, repo: string): ReviewResult {
  return {
    prNumber,
    owner,
    repo,
    summary: 'No reviewable changes found in this PR.',
    overallVerdict: 'approve',
    fileReviews: [],
    lineComments: [],
    stats: {
      filesReviewed: 0,
      filesSkipped: 0,
      totalComments: 0,
      critical: 0,
      warnings: 0,
    },
  }
}

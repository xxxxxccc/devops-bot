/**
 * Review Prompt — system and user prompt builders for the PR review AI.
 */

import type { DiffChunk } from './diff-parser.js'

export function buildReviewSystemPrompt(params: {
  projectRules?: string
  skillContent?: string
  reviewPatterns?: string
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

export function buildReviewUserPrompt(params: {
  prTitle: string
  prBody: string
  chunks: DiffChunk[]
  existingComments?: Array<{ path: string; line: number | null; body: string }>
}): string {
  const parts: string[] = [`## Pull Request: ${params.prTitle}`]

  if (params.prBody) {
    const body =
      params.prBody.length > 2000 ? `${params.prBody.slice(0, 2000)}... [truncated]` : params.prBody
    parts.push('', '### Description', '', body)
  }

  if (params.existingComments && params.existingComments.length > 0) {
    parts.push('', '### Existing Review Comments (do NOT duplicate these)', '')
    for (const c of params.existingComments.slice(0, 20)) {
      const loc = c.line ? `${c.path}:${c.line}` : c.path
      parts.push(`- [${loc}] ${c.body.slice(0, 200)}`)
    }
  }

  parts.push('', '### Changed Files', '')

  for (const chunk of params.chunks) {
    parts.push(
      `#### ${chunk.filename} (${chunk.language}, +${chunk.additions}/-${chunk.deletions}, ${chunk.status})`,
      '',
      '```diff',
      chunk.patch,
      '```',
      '',
    )
  }

  return parts.join('\n')
}

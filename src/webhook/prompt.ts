/**
 * Layer 2 Prompt Builder
 *
 * Builds the system prompt and per-task user prompt for the
 * Claude executor (Opus).  Also provides attachment type detection
 * and link detection utilities.
 */

import type { Task } from '../core/types.js'
import type { SkillEntry } from '../prompt/skill-scanner.js'
import {
  buildIdentitySection,
  buildSafetySection,
  buildProjectRulesSection,
  buildRuntimeSection,
} from '../prompt/sections.js'

/* ------------------------------------------------------------------ */
/*  Link detection utilities                                           */
/* ------------------------------------------------------------------ */

const JIRA_PATTERN = /https?:\/\/[^\s]+\.atlassian\.net\/browse\/([A-Z]+-\d+)|([A-Z]+-\d+)/gi
const FIGMA_PATTERN = /https?:\/\/(www\.)?figma\.com\/(design|file|proto)\/[a-zA-Z0-9]+/gi

export function detectJiraLinks(text: string): boolean {
  JIRA_PATTERN.lastIndex = 0
  return JIRA_PATTERN.test(text)
}

export function detectFigmaLinks(text: string): boolean {
  FIGMA_PATTERN.lastIndex = 0
  return FIGMA_PATTERN.test(text)
}

/* ------------------------------------------------------------------ */
/*  System prompt builder                                              */
/* ------------------------------------------------------------------ */

export function buildExecutorSystemPrompt(params: {
  projectRules: string
  taskHasJira: boolean
  taskHasFigma: boolean
  skills?: SkillEntry[]
  sandbox?: { branchName: string; baseBranch: string; submodules?: string[] }
}): string {
  const sections = [
    buildIdentitySection('executor'),
    buildSafetySection(),
    buildAvailableToolsSection(),
    buildSkillsSection(params.skills ?? []),
    buildWorkflowSection(!!params.sandbox),
    params.sandbox ? buildSandboxConstraintsSection(params.sandbox) : buildConstraintsSection(),
    params.taskHasJira ? buildJiraSection() : [],
    params.taskHasFigma ? buildFigmaSection() : [],
    buildProjectRulesSection(params.projectRules),
    buildRuntimeSection(),
  ]
  return sections.flat().join('\n')
}

/* ------------------------------------------------------------------ */
/*  Executor-specific sections                                         */
/* ------------------------------------------------------------------ */

function buildAvailableToolsSection(): string[] {
  return [
    '',
    '## Available Tools',
    '',
    'You have access to the following tools via MCP:',
    '- **File Operations**: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`',
    '- **Search**: `grep_search`, `glob_search`',
    '- **Git**: `git_status`, `git_diff`, `git_log`',
    '- **Shell**: `shell_exec`, `npm`',
    '- **Task**:',
    '  - `get_task_history` - Get previous task info for context (use when current task relates to previous work)',
    '  - `submit_summary` - Submit your final summary (REQUIRED at the end)',
  ]
}

function buildSkillsSection(skills: SkillEntry[]): string[] {
  if (skills.length === 0) return []

  const skillsXml = skills
    .map((s) =>
      [
        '  <skill>',
        `    <name>${s.name}</name>`,
        `    <description>${s.description}</description>`,
        `    <location>${s.location}</location>`,
        '  </skill>',
      ].join('\n'),
    )
    .join('\n')

  return [
    '',
    '## Skills (use when applicable)',
    '',
    'Before starting: scan the skill descriptions below.',
    '- If exactly one skill clearly applies to this task: read its SKILL.md with `read_file`, then follow it.',
    '- If multiple could apply: choose the most specific one, then read and follow it.',
    '- If none clearly apply: skip this section.',
    'Constraint: read at most one SKILL.md up front; only read after selecting.',
    '',
    '<available_skills>',
    skillsXml,
    '</available_skills>',
  ]
}

function buildWorkflowSection(sandboxMode: boolean): string[] {
  const steps = [
    '',
    '## Workflow',
    '',
    '**TIP**: If this task seems related to previous work or you need context about past changes,',
    'use `get_task_history` to review what has been done before.',
    '',
    '**IMPORTANT: Always start by exploring the project structure!**',
    '',
    '1. **Explore First** (Required)',
    '   - Use `list_directory` to understand the project structure',
    '   - Review the Project Development Guide (included above) and `package.json` to understand conventions',
    '   - Identify key directories (src, components, pages, etc.)',
    '',
    '2. **Search & Analyze**',
    '   - Use `grep_search` to find code related to the task',
    '   - Read relevant files to understand the implementation',
    '   - Identify what needs to be changed',
    '',
    '3. **Implement**',
    '   - Use `edit_file` to make focused changes',
    '   - Follow existing code patterns and conventions',
    '',
    '4. **Verify** (Required)',
    '   - Run type check / compile check (if applicable)',
    '   - Run lint / format check (if applicable)',
    '   - If errors found, fix them before proceeding',
  ]

  if (sandboxMode) {
    steps.push(
      '',
      '5. **Commit** (Required in sandbox mode)',
      '   - After all checks pass, stage and commit your changes:',
      '     1. `git_add` to stage all changes',
      '     2. `git_commit` with a clear, descriptive commit message in English',
      '   - Use conventional commit format: `feat:`, `fix:`, `refactor:`, etc.',
      '',
      '6. **Submit Summary** (REQUIRED - Must be the last step)',
    )
  } else {
    steps.push('', '5. **Submit Summary** (REQUIRED - Must be the last step)')
  }

  steps.push(
    '   - After completing all changes and passing all checks, call `submit_summary` tool with:',
    '     - `task_id`: The task ID provided in the user message',
    '     - `modified_files`: Array of file paths that were modified',
    '     - `thinking`: **请使用简体中文撰写**，包含以下内容：',
    '       - 问题/需求是什么',
    '       - 如何分析并找到相关代码',
    '       - 做了哪些修改，为什么',
    '       - 任何权衡或注意事项',
  )

  return steps
}

function buildConstraintsSection(): string[] {
  return [
    '',
    '## Constraints',
    '',
    '- Do NOT create new branches (work directly on current branch)',
    '- Do NOT commit changes (human will review and commit)',
    '- Do NOT push to remote',
    '- Make minimal, focused changes',
    '- Ensure all type checks and lint checks pass before finishing',
    '- You MUST call `submit_summary` at the end',
    '- Follow the project rules if provided',
    '- If unsure about something, explain your uncertainty',
  ]
}

function buildSandboxConstraintsSection(sandbox: {
  branchName: string
  baseBranch: string
  submodules?: string[]
}): string[] {
  const lines = [
    '',
    '## Constraints (Sandbox Mode)',
    '',
    `- You are working in an **isolated sandbox branch**: \`${sandbox.branchName}\``,
    `- Base branch: \`${sandbox.baseBranch}\` — your changes will become a PR against this branch`,
    '- After finishing all changes and verification, **commit your work** with a clear message',
    '- Do NOT push to remote — the system handles push and PR creation automatically',
    '- Do NOT create additional branches — stay on the current sandbox branch',
    '- Make minimal, focused changes',
    '- Ensure all type checks and lint checks pass before committing',
    '- You MUST call `submit_summary` at the end',
    '- Follow the project rules if provided',
    '- If unsure about something, explain your uncertainty',
  ]

  if (sandbox.submodules && sandbox.submodules.length > 0) {
    lines.push(
      '',
      '### Submodule Handling',
      '',
      'This project uses git submodules. The following paths are submodules:',
      ...sandbox.submodules.map((p) => `- \`${p}\``),
      '',
      '**If you modify files inside a submodule:**',
      '1. `cd` into the submodule directory first',
      '2. Stage and commit changes there (`git_add` + `git_commit` inside the submodule path)',
      '3. Then go back to the project root and stage the updated submodule reference (`git_add` the submodule path)',
      '4. Commit in the parent repo — the commit message should mention the submodule update',
      '',
      '**If you only modify files outside submodules**, just commit normally.',
    )
  }

  return lines
}

function buildJiraSection(): string[] {
  return [
    '',
    '## Jira Integration',
    '',
    'Jira issue links were detected in the task description. The following tools are available:',
    '',
    '- `jira_get_issue`: Get issue details by key (e.g., PROJ-123)',
    '- `jira_search`: Search issues with JQL',
    '- `jira_add_comment`: Add comment to an issue',
    '- `jira_update_issue`: Update issue fields',
    '- `jira_transition_issue`: Change issue status',
    '',
    '**Workflow**: Use `jira_get_issue` to fetch full issue details before starting.',
    'This will give you acceptance criteria, related issues, and more context.',
  ]
}

function buildFigmaSection(): string[] {
  return [
    '',
    '## Figma Integration',
    '',
    'Figma design links were detected in the task description. The following tools are available:',
    '',
    '- `get_design_context`: Get UI code and design context from Figma node (extract fileKey and nodeId from URL)',
    '- `get_screenshot`: Get screenshot of a Figma node',
    '- `get_metadata`: Get metadata of a Figma file',
    '- `get_variable_defs`: Get design tokens/variables from Figma',
    '',
    '**Workflow**: Use `get_design_context` to fetch design details and generate UI code.',
    'Extract fileKey and nodeId from the Figma URL (e.g., https://figma.com/design/:fileKey/:name?node-id=:nodeId).',
    'For nodeId, convert format from URL (1-2) to API format (1:2).',
  ]
}

/* ------------------------------------------------------------------ */
/*  Attachment type detection                                          */
/* ------------------------------------------------------------------ */

/**
 * Determine a human-readable type label and usage hint for an attachment.
 */
export function describeAttachment(
  mime: string,
  filename: string,
): { label: string; hint: string } {
  // Text-readable files — executor should use read_file
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return {
      label: 'Document (text)',
      hint: 'Use `read_file` to read the full content of this file.',
    }
  }
  if (mime.startsWith('image/')) {
    return {
      label: 'Image',
      hint: 'This is an image file. Refer to the task description for visual context.',
    }
  }
  if (mime.startsWith('video/')) {
    return {
      label: 'Video',
      hint: 'This is a video file. Refer to the task description for context.',
    }
  }
  if (mime === 'application/pdf') {
    return {
      label: 'Document (PDF)',
      hint: 'This is a PDF file. Content cannot be read directly.',
    }
  }

  // Fallback: guess from extension
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const textExts = new Set([
    'html',
    'htm',
    'css',
    'js',
    'ts',
    'jsx',
    'tsx',
    'json',
    'yaml',
    'yml',
    'md',
    'txt',
    'xml',
    'csv',
    'svg',
    'sh',
    'bash',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'swift',
    'vue',
    'svelte',
    'astro',
    'toml',
    'ini',
    'env',
    'conf',
    'cfg',
    'sql',
    'graphql',
    'prisma',
  ])
  if (textExts.has(ext)) {
    return {
      label: `Document (.${ext})`,
      hint: 'Use `read_file` to read the full content of this file.',
    }
  }
  return {
    label: 'File',
    hint: 'Binary file. Refer to the task description for context.',
  }
}

/* ------------------------------------------------------------------ */
/*  Task prompt (user message)                                         */
/* ------------------------------------------------------------------ */

export function buildTaskPrompt(data: {
  taskId: string
  title: string
  description?: string
  todoId?: string
  attachments?: Array<{ filename: string; originalname: string; path: string; mimetype?: string }>
}): string {
  // Attachments — typed labels and usage hints
  const attachmentsSection =
    data.attachments && data.attachments.length > 0
      ? `
## Attachments

${data.attachments
  .map((a) => {
    const mime = a.mimetype || 'application/octet-stream'
    const { label, hint } = describeAttachment(mime, a.originalname)
    return `- **${a.originalname}** -> \`${a.path}\`
  - Type: ${label}
  - ${hint}`
  })
  .join('\n')}

**IMPORTANT**: Please review these attachments first to understand the full context of the task.
`
      : ''

  const prompt = `## Task

**Task ID:** ${data.taskId}
**Title:** ${data.title}
${data.todoId ? `**Todo ID:** ${data.todoId}` : ''}

${data.description || data.title}
${attachmentsSection}
---

**Remember:** When you are done, you MUST call \`submit_summary\` with task_id="${data.taskId}"`

  return prompt
}

/* ------------------------------------------------------------------ */
/*  Continued-task prompt                                              */
/* ------------------------------------------------------------------ */

export function buildContinuedPrompt(
  previousTask: Task,
  newInstruction: string,
  newTaskId: string,
  attachments?: Array<{ path: string; originalName: string; mimetype: string }>,
): string {
  // Truncate output to keep context manageable
  const maxOutputLength = 8000
  let output = previousTask.output || ''
  if (output.length > maxOutputLength) {
    output = `...(truncated)\n${output.slice(-maxOutputLength)}`
  }

  // Sanitize old task IDs in the previous prompt
  const cleanedPreviousPrompt = previousTask.prompt
    .replace(/\*\*Task ID:\*\*\s*task-\d+/g, '**Task ID:** (previous)')
    .replace(/task_id="task-\d+"/g, 'task_id="(see below)"')

  // Build attachments section
  let attachmentsSection = ''
  if (attachments && attachments.length > 0) {
    attachmentsSection = `
## New Attachments

The following files have been uploaded as references for this instruction:

${attachments
  .map((a) => {
    const isTextFile =
      a.mimetype.startsWith('text/') || ['application/json', 'application/xml'].includes(a.mimetype)
    if (isTextFile) {
      return `- **${a.originalName}** (text file): \`${a.path}\` - Use \`read_file\` to read its content`
    }
    return `- **${a.originalName}** (${a.mimetype}): \`${a.path}\``
  })
  .join('\n')}

---
`
  }

  return `## Continued Task

**Task ID:** ${newTaskId}

This is a continuation of a previous task. Please review the context and follow the new instruction.

---

## Previous Task Context

${cleanedPreviousPrompt}

---

## Previous Execution Output

\`\`\`
${output}
\`\`\`

${previousTask.error ? `## Previous Error\n\n\`\`\`\n${previousTask.error}\n\`\`\`\n\n---\n` : ''}
## New Instruction

${newInstruction}
${attachmentsSection}
---

**Note:** Continue from where the previous task left off. Do NOT repeat work that was already completed successfully.

**Remember:** When calling \`submit_summary\`, use task_id="${newTaskId}"`
}

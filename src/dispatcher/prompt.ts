/**
 * Dispatcher Prompt — system prompt and user-prompt builder.
 *
 * The system prompt is assembled from shared sections (src/prompt/sections.ts)
 * plus dispatcher-specific sections defined here.
 */

import type { ChatMessage } from '../memory/types.js'
import type { MemoryRetriever } from '../memory/retriever.js'
import type { MemoryStore } from '../memory/store.js'
import type { Attachment, ExtractedLink } from '../channels/types.js'

interface ParsedMessage {
  text: string
  sender: { name: string }
  attachments: Attachment[]
  links: ExtractedLink[]
}
import type { DispatcherMemoryConfig } from './config.js'
import {
  buildIdentitySection,
  buildSafetySection,
  buildProjectRulesSummary,
  buildRuntimeSection,
} from '../prompt/sections.js'

/* ------------------------------------------------------------------ */
/*  System prompt builder                                              */
/* ------------------------------------------------------------------ */

export function buildDispatcherSystemPrompt(params: {
  projectRules: string
  memoryAvailable: boolean
}): string {
  const sections = [
    buildIdentitySection('dispatcher'),
    buildResponsibilitiesSection(),
    buildCodeToolsSection(),
    buildSkillToolsSection(),
    params.memoryAvailable ? buildMemorySection() : [],
    buildActionsSection(),
    buildResponseFormatSection(),
    buildReplyGuidelinesSection(),
    buildSafetySection(),
    buildDispatcherSafetyExtras(),
    buildProjectRulesSummary(params.projectRules),
    buildRuntimeSection(),
  ]
  return sections.flat().join('\n')
}

/* ------------------------------------------------------------------ */
/*  Dispatcher-specific sections                                       */
/* ------------------------------------------------------------------ */

function buildResponsibilitiesSection(): string[] {
  return [
    '',
    '## Your Responsibilities',
    '',
    "1. Understand the user's intent from their message and conversation history",
    '2. **Leverage project context** (structure, conventions, dependencies) and memory to give informed answers',
    '3. **When needed, use tools to inspect the codebase** before answering or creating a task',
    '4. Decide the appropriate action',
    '5. For chat/query intents, generate a direct reply using project context, memory, and tool results',
  ]
}

function buildCodeToolsSection(): string[] {
  return [
    '',
    '## Code Inspection Tools',
    '',
    "You have read-only tools to inspect the target project's codebase:",
    '',
    '- **grep_search** — search for code patterns, function names, class names, strings in files',
    '- **read_file** — read specific files (use offset/limit for large files)',
    '- **list_directory** — list directory contents',
    '- **glob_search** — find files matching a pattern (e.g., "**/*.tsx")',
    '',
    '**When to use tools:**',
    '- User asks about specific code, files, or functions -> search first, then answer with facts',
    '- User reports a bug or issue -> look at the relevant code before creating a task',
    '- User asks "where is X" or "how does X work" -> use grep/read to find the answer',
    '- When you need to verify something before answering — always prefer checking over guessing',
    '',
    '**When NOT to use tools:**',
    "- Simple greetings, general questions, or conversations that don't need code details",
    '- When the memory system already has the answer',
  ]
}

function buildSkillToolsSection(): string[] {
  return [
    '',
    '## Skill Management Tools',
    '',
    'You can manage skills for the project — skills provide domain-specific guidance for the Task AI executor.',
    '',
    '- **find_skills** — search the open agent skills ecosystem for available skills',
    '- **list_installed_skills** — show skills currently installed in the project',
    "- **install_skill** — install a skill from skills.sh or GitHub into the project's skills/ directory",
    '- **create_skill** — create a custom skill from scratch (from conversation history, user-provided content, or project knowledge)',
    '',
    '**When to use skill tools:**',
    '- User asks "what skills are available" or "find skills for X" -> use find_skills',
    '- User asks "list our skills" or "list installed skills" -> use list_installed_skills',
    '- User shares a skills.sh link or GitHub skill path -> use install_skill',
    '- User wants to create a custom skill from scratch -> use create_skill (see below)',
    '',
    '**Creating custom skills (create_skill):**',
    '',
    '⚠️ IMPORTANT: Before creating a skill, FIRST read `skills/skill-creator/SKILL.md` if it exists!',
    'This skill contains best practices for creating high-quality skills:',
    '- Progressive Disclosure: Keep SKILL.md lean (<500 lines), split details into references/',
    "- Concise is Key: Only add context the AI doesn't already have",
    '- Good description: Must explain WHAT it does AND WHEN to use it (triggers)',
    '- Proper structure: frontmatter (name, description) + markdown body',
    '',
    'Use create_skill when user wants to:',
    '- Summarize past conversations/decisions into a reusable skill',
    '- Add a workflow or guideline they described',
    '- Paste SKILL.md-like content to be added',
    '',
    '**CRITICAL: Before calling create_skill, you MUST have ALL THREE required pieces:**',
    '1. **name** — kebab-case identifier (e.g., "api-error-handling")',
    '2. **description** — one clear sentence explaining WHAT it does AND WHEN to trigger it',
    '   Example: "API error handling patterns including error codes, response format, and logging. Use when implementing or reviewing error handling in API endpoints."',
    '3. **content** — the actual instructions, guidelines, code examples',
    '   Keep it concise and actionable. Prefer examples over explanations.',
    '',
    'If ANY of these is missing or unclear, DO NOT call create_skill. Instead:',
    '- Ask the user to provide the missing information',
    '- For name: suggest a kebab-case name based on the topic and ask for confirmation',
    '- For description: draft a one-liner with WHAT + WHEN and ask if it captures the intent',
    '- For content: ask what specific guidance, rules, or examples should be included',
    '',
    'Example dialogue:',
    '  User: "Summarize our previous error handling discussion into a skill"',
    '  You: "Sure, I\'ll create that skill. Based on our discussion, I suggest:',
    '        - Name: `api-error-handling`',
    '        - Description: API error handling patterns including error codes, response format, and logging. Use when implementing or reviewing error handling in API endpoints.',
    '        - Key points: [concise bullet list]',
    '        Does this look right? Anything to add or change?"',
  ]
}

function buildMemorySection(): string[] {
  return [
    '',
    '## Memory System',
    '',
    'You have access to a hierarchical project memory organized as:',
    '- **decision/** - Technical decisions and their reasoning',
    '- **context/** - Project architecture, conventions, directory structure',
    '- **preference/** - User preferences, code style, tool choices',
    '- **issue/** - Known issues, bugs, tech debt',
    '- **task_input/** - Past task requirements (who requested what)',
    '- **task_result/** - Past task execution results (what was done, files changed)',
    '- **conversations/** - Chat history organized by date',
    '',
    'A compact memory summary is included in prompts; memory index may be included when useful.',
    'Use it to:',
    '- Reference past decisions when discussing technical choices',
    '- Consider known issues when planning new tasks',
    '- Recall who requested what and what happened',
    '- Build on previous task results',
  ]
}

function buildActionsSection(): string[] {
  return [
    '',
    '## Available Actions',
    '',
    '### Conversation',
    '',
    '- **chat**: General conversation, Q&A, clarification, greeting',
    '- **query_memory**: User asks about past work, decisions, project history',
    '',
    '### Three-Tier Task Execution',
    '',
    '- **execute_task** (Tier 1 — low risk, immediate execution)',
    '  - Clear scope, few files, easily reversible, no breaking changes',
    '  - Examples: copy/text updates, config tweaks, simple bug fixes, style adjustments',
    '  - An Issue is auto-created for tracking; the resulting PR links to it',
    '  - No human approval needed — speed is the priority',
    '',
    '- **propose_task** (Tier 2 — medium risk, needs approval)',
    '  - New features, refactoring, multi-module changes, adding dependencies',
    '  - Creates an Issue with approval instructions; waits for ✅ reaction before executing',
    '  - Reply MUST explain: (1) what will be done, (2) why it was NOT executed immediately',
    '  - Common reasons: touches multiple modules, adds new dependency, needs design review, could affect other features',
    '',
    '- **create_issue** (Tier 3 — high risk / unclear, discussion only)',
    '  - Architecture changes, vague requests, data migrations, breaking API changes',
    '  - Only creates an Issue for discussion, no auto-execution',
    '  - Reply MUST explain WHY this was not executed, using one of these categories:',
    '    - 🔴 **High risk**: could break existing functionality or requires careful design',
    '    - 🟡 **Needs clarification**: request is vague or has multiple valid approaches',
    '    - 📋 **Scope too large**: requires breakdown into smaller tasks first',
    '    - 💬 **Needs discussion**: architectural decision that stakeholders should weigh in on',
    '',
    '### Modifying an Existing PR',
    '',
    '- When the user wants to **modify an existing PR** (not create a new one), use `execute_task` with `prNumber`',
    '  - The bot checks out the PR branch, applies changes, and pushes to the same PR',
    '  - Examples: "修改 PR #23", "fix the issues in PR 45", "update PR #12 to add error handling", "按照 PR 评论修改"',
    '  - Requires both `taskTitle`/`taskDescription` AND `prNumber`',
    '  - The `riskReason` and tier rules still apply',
    '',
    '### Code Review',
    '',
    '- **review_pr**: User wants an AI code review of a pull request (read-only, no code changes)',
    '  - Requires `prNumber` in response',
    '  - Examples: "review PR #123", "帮我看看 PR 45", "code review pull request 78"',
    '  - The bot will analyze the PR diff and submit a GitHub review with summary + line comments',
    '',
    '### Project Management',
    '',
    '- **add_project**: User wants to bind a git repository to this chat',
    '  - Requires `gitUrl` in response',
    '  - Examples: "add project https://github.com/org/repo", "bind repo git@github.com:org/repo.git"',
    '',
    '- **add_workspace**: User wants to bind a workspace (meta-repo with workspace.json) to this chat',
    '  - Requires `gitUrl` in response',
    '  - A workspace lists multiple sub-projects; after adding, all sub-projects become available',
    '  - Examples: "add workspace https://github.com/org/workspace", "bind workspace git@github.com:org/ws.git"',
    '',
    '- **remove_project**: User wants to unbind a project from this chat',
    '  - Requires `projectId` in response',
    '',
    '## Risk Assessment (choosing the right tier)',
    '',
    'Before deciding, use code inspection tools to understand the scope. Assess:',
    '',
    '- **Specificity**: Is it clear exactly what to change? (high = Tier 1)',
    '- **Scope**: How many files/modules? (few = Tier 1, many = Tier 2+)',
    '- **Reversibility**: Can it be easily reverted? (yes = Tier 1)',
    '- **Breaking potential**: Could it break existing functionality? (yes = Tier 2/3)',
    '- **Design decisions**: Are there multiple valid approaches? (yes = Tier 3)',
    '',
    'You MUST include a `riskReason` explaining your tier choice for execute_task, propose_task, and create_issue.',
  ]
}

function buildResponseFormatSection(): string[] {
  return [
    '',
    '## Response Format',
    '',
    'CRITICAL: Respond with ONLY a JSON object — NO prose, NO markdown fences, NO explanation before or after.',
    'Your entire response must be valid JSON and nothing else:',
    '{',
    '  "intent": "chat | query_memory | execute_task | propose_task | create_issue | add_project | remove_project | review_pr | add_workspace",',
    '  "projectId": "project ID from the project list (required when projects exist)",',
    '  "reply": "your reply to the user",',
    '  "taskTitle": "title (required for execute_task, propose_task, create_issue)",',
    '  "taskDescription": "structured description, keep under 1000 chars",',
    '  "riskReason": "why this tier was chosen (required for execute_task, propose_task, create_issue)",',
    '  "issueLabels": ["optional", "labels"],',
    '  "gitUrl": "git URL (required for add_project / add_workspace)",',
    '  "targetGitUrl": "git URL of the target sub-project (workspace mode, for on-demand clone)",',
    '  "targetBranch": "branch override for the target sub-project (workspace mode)",',
    '  "prNumber": "PR number (required for review_pr; optional for execute_task to modify an existing PR)",',
    "  \"language\": \"detected language of the user message (e.g. 'zh-CN', 'en', 'ja')\"",
    '}',
    '',
    '### Project selection rules',
    '- If the chat has exactly 1 project, auto-select it (always include its projectId)',
    '- If multiple projects, choose based on message context',
    '- If ambiguous which project, ask the user to clarify (intent=chat)',
    '- add_project, add_workspace, and remove_project do not need projectId',
    '',
    '### Workspace sub-project selection rules',
    '- When a workspace is bound, you can see all sub-projects in the workspace context',
    '- For task/review intents targeting a sub-project, include `targetGitUrl` and `targetBranch` from the workspace manifest',
    '- If the sub-project is already registered (has a projectId), also include `projectId`',
    '- If the sub-project is NOT yet registered (not cloned), set `projectId` to the workspace-provided ID and include `targetGitUrl` — the system will clone it on demand',
  ]
}

function buildReplyGuidelinesSection(): string[] {
  return [
    '',
    '## Reply Guidelines',
    '',
    '### Tone & Style',
    '- Detect the user\'s language and set the `language` field (e.g. "zh-CN", "en")',
    '- reply, taskTitle, and taskDescription MUST all be in the same language as the user message',
    '- Be concise — 1-3 short paragraphs max for chat replies, no walls of text',
    '- Use a professional but approachable tone, like a senior engineer talking to a teammate',
    '- Avoid filler phrases ("Sure thing!", "Of course!", "Great question!")',
    '- Get to the point: lead with the answer, then add context if needed',
    '',
    '### Content Quality',
    '- **NEVER fabricate** file names, function names, class names, or code details that you haven\'t seen in the project context or memory. If you don\'t have enough information, say "I need to check the code first to confirm" and suggest creating a task to investigate',
    '- Only reference specific files/functions if they appear in the Directory Structure, memory, or conversation history provided to you',
    '- When answering technical questions with known context, give concrete specifics (file paths, config names, command examples)',
    '- If you don\'t know or the memory has no relevant info, say so honestly — "I don\'t have records on this, let me check" is always better than guessing',
    '- Reference memory naturally: "Based on previous records, ..." or "In the last task, we mentioned..."',
    '- When multiple approaches exist, briefly list trade-offs instead of picking one silently',
    '- For status queries ("Has XX been done?"), give a clear yes/no first, then details',
    '',
    '### Task / Issue Tier Guards',
    '- When unsure if something is a task, ask for clarification (intent=chat)',
    '- Vague one-liners ("optimize performance") -> create_issue (Tier 3) with label "discussion"',
    '- Destructive operations (delete files, drop tables) -> create_issue (Tier 3) for human review',
    '- Changes touching core architecture or shared modules -> propose_task (Tier 2) or create_issue (Tier 3)',
    '- New features, adding dependencies, refactoring -> propose_task (Tier 2)',
    '- Clear, specific, bounded, low-risk changes -> execute_task (Tier 1)',
    '- For execute_task/propose_task, structure the description well so the Task AI can execute effectively',
    '- When creating tasks or issues, include relevant memory context for full history',
    '- For propose_task, explain in `reply`: what the change involves and why manual approval is needed before execution',
    '- For create_issue, explain in `reply`: why this was NOT executed — be specific (high risk / vague / too large / needs discussion)',
    '- Always include `riskReason` when choosing any task/issue tier — this is visible to the user in the Issue and chat',
  ]
}

function buildDispatcherSafetyExtras(): string[] {
  return [
    "- **Out of scope**: For non-technical requests (HR, legal, personal), politely redirect — you're a DevOps engineer, not a general assistant",
    '- **NEVER expose internal system details** in replies. Do not mention:',
    '  Memory Storage, JSONL, task_input, task_result, memory index, dispatcher,',
    '  Layer 1/Layer 2, system prompt, or any internal architecture terms.',
    '  Speak as a knowledgeable team member, not as a system querying a database.',
  ]
}

/* ------------------------------------------------------------------ */
/*  User prompt builder                                                */
/* ------------------------------------------------------------------ */

export interface DispatcherPromptMetrics {
  totalChars: number
  totalTruncated: boolean
  projectContextChars: number
  memoryIndexIncluded: boolean
  memoryIndexChars: number
  memorySummaryChars: number
  detailedMemoryChars: number
  memoryBudgetHit: boolean
  recentChatChars: number
  recentChatDropped: number
  messageChars: number
  attachmentsChars: number
  linksChars: number
}

export interface WorkspaceProjectEntry {
  id: string
  gitUrl: string
  branch: string
  lang?: string
  description?: string
  cloned: boolean
}

export interface WorkspaceContextEntry {
  id: string
  context: string
  projects: WorkspaceProjectEntry[]
}

export function buildDispatcherPrompt(
  parsed: ParsedMessage,
  recentChat: ChatMessage[],
  opts: {
    projectContext: string
    memoryStore: MemoryStore | null
    retriever: MemoryRetriever
    projectPath: string
    memorySummary: string
    detailedMemoryContext: string
    memoryIntent: boolean
    memoryConfig: DispatcherMemoryConfig
    chatProjects?: Array<{ id: string; gitUrl: string; lastUsed: string }>
    workspaces?: WorkspaceContextEntry[]
  },
): { prompt: string; metrics: DispatcherPromptMetrics } {
  const config = opts.memoryConfig
  const parts: string[] = []

  const metrics: DispatcherPromptMetrics = {
    totalChars: 0,
    totalTruncated: false,
    projectContextChars: 0,
    memoryIndexIncluded: false,
    memoryIndexChars: 0,
    memorySummaryChars: 0,
    detailedMemoryChars: 0,
    memoryBudgetHit: false,
    recentChatChars: 0,
    recentChatDropped: 0,
    messageChars: parsed.text.length,
    attachmentsChars: 0,
    linksChars: 0,
  }

  // 0. Project context — always considered, but bounded.
  if (opts.projectContext) {
    const boundedContext = truncateWithEllipsis(
      opts.projectContext,
      config.projectContextBudgetChars,
    )
    if (boundedContext) {
      parts.push(boundedContext)
      metrics.projectContextChars = boundedContext.length
    }
  }

  // 1. Memory index — injected conditionally.
  if (opts.memoryStore && shouldIncludeMemoryIndex(opts.memoryIntent, config)) {
    const index = opts.memoryStore.getMemoryIndex(opts.projectPath)
    const dates = opts.memoryStore.getConversationDates()
    const hasContent = index.some((c) => c.count > 0) || dates.length > 0
    if (hasContent) {
      const rawIndex = opts.retriever.formatMemoryIndex(index, dates)
      const boundedIndex = truncateWithEllipsis(rawIndex, config.indexBudgetChars)
      if (boundedIndex) {
        parts.push('## Memory Storage Index')
        parts.push('```')
        parts.push(boundedIndex)
        parts.push('```')
        metrics.memoryIndexIncluded = true
        metrics.memoryIndexChars = boundedIndex.length
      }
    }
  }

  // 2. Two-stage memory context under a shared budget.
  const summaryBlock =
    opts.memorySummary && opts.memorySummary !== '(no relevant memories found)'
      ? `## Relevant Memory Summaries\n${opts.memorySummary}`
      : ''
  const detailBlock =
    opts.detailedMemoryContext && opts.detailedMemoryContext !== '(no relevant memories found)'
      ? `## Detailed Memories\n${opts.detailedMemoryContext}`
      : ''

  let memoryRemaining = config.memorySectionBudgetChars
  if (memoryRemaining > 0 && summaryBlock) {
    const boundedSummary = truncateWithEllipsis(summaryBlock, memoryRemaining)
    if (boundedSummary) {
      parts.push(`\n${boundedSummary}`)
      metrics.memorySummaryChars = boundedSummary.length
      memoryRemaining = Math.max(0, memoryRemaining - boundedSummary.length)
      if (boundedSummary.length < summaryBlock.length) {
        metrics.memoryBudgetHit = true
      }
    }
  }

  if (memoryRemaining > 0 && detailBlock) {
    const boundedDetail = truncateWithEllipsis(detailBlock, memoryRemaining)
    if (boundedDetail) {
      parts.push(`\n${boundedDetail}`)
      metrics.detailedMemoryChars = boundedDetail.length
      memoryRemaining = Math.max(0, memoryRemaining - boundedDetail.length)
      if (boundedDetail.length < detailBlock.length) {
        metrics.memoryBudgetHit = true
      }
    }
  } else if (detailBlock) {
    metrics.memoryBudgetHit = true
  }

  // 3. Recent conversation under separate budget.
  const recentSection = buildRecentConversationSection(recentChat, config.recentChatBudgetChars)
  if (recentSection.section) {
    parts.push(`\n## Recent Conversation`)
    parts.push(recentSection.section)
    metrics.recentChatChars = recentSection.section.length
    metrics.recentChatDropped = recentSection.dropped
  }

  // 4. Chat project list (multi-project mode)
  const hasWorkspaces = opts.workspaces && opts.workspaces.length > 0
  if (opts.chatProjects && opts.chatProjects.length > 0) {
    parts.push('\n## Projects in this chat')
    for (let i = 0; i < opts.chatProjects.length; i++) {
      const p = opts.chatProjects[i]
      const ago = formatTimeAgo(p.lastUsed)
      parts.push(`${i + 1}. \`${p.id}\` (last used: ${ago})`)
    }
    if (opts.chatProjects.length === 1 && !hasWorkspaces) {
      parts.push('\nOnly one project — auto-select it for all intents.')
    }
  } else if (!opts.projectPath && !hasWorkspaces) {
    parts.push(
      '\n## Projects in this chat',
      'No projects bound. Tell the user to add one with "add project <git URL>" or "add workspace <git URL>".',
    )
  }

  // 4b. Workspace context (workspace mode)
  if (hasWorkspaces) {
    for (const ws of opts.workspaces!) {
      parts.push(`\n## Workspace: ${ws.id}`)

      if (ws.projects.length > 0) {
        parts.push('\n### Available Sub-Projects')
        parts.push(
          '| ID | Language | Branch | Status | Git URL | Description |',
          '|----|----------|--------|--------|---------|-------------|',
        )
        for (const p of ws.projects) {
          const status = p.cloned ? 'cloned' : 'not yet cloned'
          parts.push(
            `| ${p.id} | ${p.lang || '-'} | ${p.branch} | ${status} | ${p.gitUrl} | ${p.description || '-'} |`,
          )
        }
        parts.push(
          '',
          'When targeting a sub-project, include `targetGitUrl` and `targetBranch` in your response.',
          'The system will clone it on demand if not yet available locally.',
        )
      }

      if (ws.context) {
        const truncated =
          ws.context.length > 4000 ? `${ws.context.slice(0, 4000)}\n... [truncated]` : ws.context
        parts.push('\n### Workspace Guidelines', '', truncated)
      }
    }
  }

  // 5. New message
  parts.push(`\n## New Message from ${parsed.sender.name}`)
  parts.push(parsed.text)

  // 5. Attachments — images are sent as multimodal blocks; other files listed here for tool access
  const nonImageAttachments = parsed.attachments.filter((a) => !a.mimetype.startsWith('image/'))
  if (nonImageAttachments.length > 0) {
    const attachmentLines: string[] = []
    attachmentLines.push('\n## Attached Files')
    attachmentLines.push(
      'These files were sent by the user. Use `read_file` to read their content when needed.',
    )
    for (const a of nonImageAttachments) {
      attachmentLines.push(`- **${a.originalname}** (${a.mimetype}): \`${a.path}\``)
    }
    const block = attachmentLines.join('\n')
    parts.push(block)
    metrics.attachmentsChars = block.length
  }

  // 6. Links
  if (parsed.links.length > 0) {
    const linkLines: string[] = []
    linkLines.push('\n## Detected Links')
    for (const l of parsed.links) {
      linkLines.push(`- [${l.type}${l.key ? `: ${l.key}` : ''}] ${l.url}`)
    }
    const block = linkLines.join('\n')
    parts.push(block)
    metrics.linksChars = block.length
  }

  let prompt = parts.join('\n')
  if (prompt.length > config.maxPromptChars) {
    prompt = `${prompt.slice(0, config.maxPromptChars)}\n... [truncated by dispatcher max prompt budget]`
    metrics.totalTruncated = true
  }

  metrics.totalChars = prompt.length
  return { prompt, metrics }
}

function shouldIncludeMemoryIndex(memoryIntent: boolean, config: DispatcherMemoryConfig): boolean {
  if (config.includeMemoryIndex === 'always') return true
  if (config.includeMemoryIndex === 'never') return false
  return memoryIntent
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars <= 6) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - 3)}...`
}

function buildRecentConversationSection(
  recentChat: ChatMessage[],
  maxChars: number,
): { section: string; dropped: number } {
  if (recentChat.length === 0 || maxChars <= 0) {
    return { section: '', dropped: 0 }
  }

  const lines: string[] = []
  let used = 0

  // Prefer newest messages; render output in chronological order.
  for (let i = recentChat.length - 1; i >= 0; i--) {
    const msg = recentChat[i]
    const name = msg.senderName || msg.role
    const line = `${name}: ${msg.content}`
    const extra = lines.length === 0 ? line.length : line.length + 1
    if (used + extra > maxChars) break
    lines.unshift(line)
    used += extra
  }

  const dropped = Math.max(0, recentChat.length - lines.length)
  return { section: lines.join('\n'), dropped }
}

/* ------------------------------------------------------------------ */
/*  Task description builder                                           */
/* ------------------------------------------------------------------ */

/**
 * Combine dispatcher's AI-structured description with raw artifacts.
 * Layer 2 (Opus) receives everything it needs to work.
 */
export function buildEnrichedTaskDescription(
  aiDescription: string,
  attachments: Attachment[],
  links: ExtractedLink[],
  sender: string,
): string {
  const parts = [`Requested by: ${sender}\n`, aiDescription]

  // Append reference links (Jira, Figma, etc.)
  if (links.length > 0) {
    parts.push('\n## Reference Links')
    for (const link of links) {
      if (link.type === 'jira') {
        parts.push(`- Jira: ${link.url} (${link.key})`)
      } else if (link.type === 'figma') {
        parts.push(`- Figma Design: ${link.url}`)
      } else if (link.type === 'github') {
        parts.push(`- GitHub: ${link.url}`)
      } else if (link.type === 'gitlab') {
        parts.push(`- GitLab: ${link.url}`)
      } else {
        parts.push(`- Reference: ${link.url}`)
      }
    }
  }

  // Append attachment paths (Layer 2 can read these files via MCP tools)
  if (attachments.length > 0) {
    parts.push('\n## Attached Files')
    for (const att of attachments) {
      parts.push(`- ${att.originalname}: ${att.path}`)
    }
  }

  return parts.join('\n')
}

function formatTimeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

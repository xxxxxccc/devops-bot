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
    '- User asks "有什么skill可以用" or "find skills for X" -> use find_skills',
    '- User asks "我们有哪些skill" or "list installed skills" -> use list_installed_skills',
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
    '  User: "帮我把之前关于错误处理的讨论总结成一个skill"',
    '  You: "好的，我来帮你创建这个skill。根据之前的讨论，我建议：',
    '        - 名称: `api-error-handling`',
    '        - 描述: API错误处理模式，包括错误码、响应格式和日志规范。在实现或审查API端点的错误处理时使用。',
    '        - 内容要点: [简洁的要点列表]',
    '        这样可以吗？需要补充或修改什么？"',
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
    '- **chat**: General conversation, Q&A, clarification, greeting',
    '  - Generate a helpful reply directly',
    '  - Use project context, memory, and tool results to give informed answers',
    '',
    '- **query_memory**: User asks about past work, decisions, project history',
    '  - Reference the memory index and relevant items provided',
    '  - Synthesize them into a clear, specific answer',
    '',
    '- **create_task**: User describes a code change, bug fix, feature, or any codebase work',
    '  - Extract a clear title and structured description',
    '  - Include any mentioned file paths, error messages, Jira/Figma links',
    '  - Reference relevant context (project conventions, past decisions, known issues) in the description',
    '  - Do NOT attempt to implement - a specialized Task AI will handle execution',
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
    '  "intent": "chat" | "query_memory" | "create_task",',
    '  "reply": "your reply to the user (required for chat/query_memory)",',
    '  "taskTitle": "extracted task title (required for create_task)",',
    '  "taskDescription": "structured task description, keep under 1000 chars (required for create_task)"',
    '}',
  ]
}

function buildReplyGuidelinesSection(): string[] {
  return [
    '',
    '## Reply Guidelines',
    '',
    '### Tone & Style',
    '- Reply in the same language as the user (Chinese/English)',
    '- Be concise — 1-3 short paragraphs max for chat replies, no walls of text',
    '- Use a professional but approachable tone, like a senior engineer talking to a teammate',
    '- Avoid filler phrases ("好的呢~", "当然可以!", "非常感谢您的提问!")',
    '- Get to the point: lead with the answer, then add context if needed',
    '',
    '### Content Quality',
    '- **NEVER fabricate** file names, function names, class names, or code details that you haven\'t seen in the project context or memory. If you don\'t have enough information, say "我需要先看一下代码才能确认" and suggest creating a task to investigate',
    '- Only reference specific files/functions if they appear in the Directory Structure, memory, or conversation history provided to you',
    '- When answering technical questions with known context, give concrete specifics (file paths, config names, command examples)',
    '- If you don\'t know or the memory has no relevant info, say so honestly — "这块我没有相关记录，需要确认一下" is always better than guessing',
    '- Reference memory naturally: "根据之前的记录，..." or "上次任务中提到..."',
    '- When multiple approaches exist, briefly list trade-offs instead of picking one silently',
    '- For status queries ("XX做了吗?"), give a clear yes/no first, then details',
    '',
    '### Task Creation Guards',
    '- When unsure if something is a task, ask for clarification (intent=chat)',
    '- Vague one-liners ("优化一下性能") -> ask for specifics before creating a task',
    '- Destructive operations (delete files, drop tables, remove features, reset data) -> confirm intent and scope first (intent=chat), then create_task only after confirmation',
    '- Changes touching core architecture or shared modules -> acknowledge the risk in reply, then create_task with warnings in description',
    '- For create_task, structure the description well so the Task AI can execute effectively',
    '- When creating tasks, include relevant memory context so the Task AI has full history',
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

  // 4. New message
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

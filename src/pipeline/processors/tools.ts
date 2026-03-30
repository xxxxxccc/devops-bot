import type { Processor } from '../types.js'

const DISPATCHER_CODE_TOOLS = [
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
].join('\n')

const EXECUTOR_TOOLS = [
  '',
  '## Available Tools',
  '',
  'You have access to the following tools via MCP:',
  '- **File Operations**: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`',
  '- **Search**: `grep_search`, `glob_search`',
  '- **Git**: `git_status`, `git_diff`, `git_log`',
  '- **Shell**: `shell_exec`, `npm` (can run git clone, cp, curl, mv for binary file operations)',
  '- **Task**:',
  '  - `get_task_history` - Get previous task info for context (use when current task relates to previous work)',
  '  - `submit_summary` - Submit your final summary (REQUIRED at the end)',
].join('\n')

/**
 * Injects available tools description into the system prompt.
 */
export const ToolsProcessor: Processor = {
  id: 'tools',
  order: 90,
  roles: ['dispatcher', 'executor', 'reviewer'],
  async process(ctx) {
    const content = ctx.role === 'dispatcher' ? DISPATCHER_CODE_TOOLS : EXECUTOR_TOOLS
    ctx.systemSections.push({ id: 'tools', content, priority: 90 })
    return ctx
  },
}

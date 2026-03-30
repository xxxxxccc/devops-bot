import type { Processor } from '../types.js'

const WORKING_MEMORY_TEMPLATE = JSON.stringify(
  {
    user_preferences: { language: '', notification_level: 'normal' },
    current_focus: { issues: [], prs: [], project: '' },
    project_status: { recent_tasks: [], blocked_items: [] },
    conversation_notes: '',
  },
  null,
  2,
)

/**
 * Injects per-chat working memory into the dispatcher system prompt.
 *
 * After the AI responds, the caller should call `extractWorkingMemoryUpdate()`
 * to detect and persist any updates.
 *
 * State keys:
 *   - workingMemoryJson (read): current JSON string
 */
export const WorkingMemoryProcessor: Processor = {
  id: 'working-memory',
  order: 65,
  roles: ['dispatcher'],
  async process(ctx) {
    const json = (ctx.state.get('workingMemoryJson') as string) || WORKING_MEMORY_TEMPLATE

    const content = [
      '',
      '## Working Memory (per-chat state)',
      '',
      'Below is the current structured state for this chat session.',
      'If the user changes preferences, shifts focus, or you learn something new,',
      'include the FULL updated JSON inside `<working_memory>` tags in your response.',
      'Only include the tags when something actually changed — omit them otherwise.',
      '',
      '```json',
      json,
      '```',
    ].join('\n')

    ctx.systemSections.push({ id: 'working-memory', content, priority: 65 })
    return ctx
  },
}

const WM_OPEN = '<working_memory>'
const WM_CLOSE = '</working_memory>'

/**
 * Extract a `<working_memory>` block from AI response text.
 * Returns the inner JSON string if present, or null.
 * Also returns the cleaned text with the tags stripped.
 */
export function extractWorkingMemoryUpdate(text: string): {
  updatedJson: string | null
  cleanedText: string
} {
  const openIdx = text.indexOf(WM_OPEN)
  if (openIdx === -1) return { updatedJson: null, cleanedText: text }

  const closeIdx = text.indexOf(WM_CLOSE, openIdx)
  if (closeIdx === -1) return { updatedJson: null, cleanedText: text }

  const inner = text.slice(openIdx + WM_OPEN.length, closeIdx).trim()

  try {
    JSON.parse(inner)
  } catch {
    return { updatedJson: null, cleanedText: text }
  }

  const cleaned = (text.slice(0, openIdx) + text.slice(closeIdx + WM_CLOSE.length)).trim()
  return { updatedJson: inner, cleanedText: cleaned }
}

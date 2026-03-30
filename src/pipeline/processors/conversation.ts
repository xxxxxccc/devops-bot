import type { Processor } from '../types.js'

interface ChatMessage {
  role: string
  content: string
  senderName?: string
}

const MAX_RECENT_CHARS = 8000

/**
 * Injects recent conversation history into the user prompt.
 * State key: recentChat
 */
export const ConversationProcessor: Processor = {
  id: 'conversation',
  order: 60,
  roles: ['dispatcher'],
  async process(ctx) {
    const recentChat = (ctx.state.get('recentChat') as ChatMessage[]) || []
    if (recentChat.length === 0) return ctx

    const maxChars = Math.min(MAX_RECENT_CHARS, ctx.budget.remaining)
    if (maxChars <= 0) return ctx

    const lines: string[] = []
    let used = 0

    for (let i = recentChat.length - 1; i >= 0; i--) {
      const msg = recentChat[i]
      const name = msg.senderName || msg.role
      const line = `${name}: ${msg.content}`
      const extra = lines.length === 0 ? line.length : line.length + 1
      if (used + extra > maxChars) break
      lines.unshift(line)
      used += extra
    }

    if (lines.length > 0) {
      ctx.userSections.push({
        id: 'conversation',
        content: `\n## Recent Conversation\n${lines.join('\n')}`,
        priority: 60,
      })
    }
    return ctx
  },
}

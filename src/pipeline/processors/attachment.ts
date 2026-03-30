import type { Attachment } from '../../channels/types.js'
import type { Processor } from '../types.js'

/**
 * Injects attachment info into the user prompt (dispatcher).
 * Reads from ctx.attachments directly.
 */
export const AttachmentProcessor: Processor = {
  id: 'attachment',
  order: 120,
  roles: ['dispatcher'],
  async process(ctx) {
    const attachments = (ctx.attachments || []) as Attachment[]
    const nonImage = attachments.filter((a) => !a.mimetype.startsWith('image/'))
    if (nonImage.length === 0) return ctx

    const lines: string[] = [
      '\n## Attached Files',
      'These files were sent by the user. Use `read_file` to read their content when needed.',
    ]
    for (const a of nonImage) {
      lines.push(`- **${a.originalname}** (${a.mimetype}): \`${a.path}\``)
    }

    ctx.userSections.push({ id: 'attachments', content: lines.join('\n'), priority: 120 })
    return ctx
  },
}

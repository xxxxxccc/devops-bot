import { buildIdentitySection } from '../../prompt/sections.js'
import type { Processor } from '../types.js'

export const IdentityProcessor: Processor = {
  id: 'identity',
  order: 10,
  roles: ['dispatcher', 'executor', 'reviewer'],
  async process(ctx) {
    const role = ctx.role === 'reviewer' ? 'executor' : ctx.role
    const lines = buildIdentitySection(role)
    ctx.systemSections.push({ id: 'identity', content: lines.join('\n'), priority: 10 })
    return ctx
  },
}

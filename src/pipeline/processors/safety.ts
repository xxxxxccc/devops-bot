import { buildSafetySection } from '../../prompt/sections.js'
import type { Processor } from '../types.js'

export const SafetyProcessor: Processor = {
  id: 'safety',
  order: 20,
  roles: ['dispatcher', 'executor', 'reviewer'],
  async process(ctx) {
    const lines = buildSafetySection()
    ctx.systemSections.push({ id: 'safety', content: lines.join('\n'), priority: 20 })
    return ctx
  },
}

import { buildProjectRulesSection, buildProjectRulesSummary } from '../../prompt/sections.js'
import type { Processor } from '../types.js'

export const ProjectRulesProcessor: Processor = {
  id: 'project-rules',
  order: 30,
  roles: ['dispatcher', 'executor', 'reviewer'],
  async process(ctx) {
    const rules = (ctx.state.get('projectRules') as string) || ''
    if (!rules) return ctx

    const lines =
      ctx.role === 'dispatcher' ? buildProjectRulesSummary(rules) : buildProjectRulesSection(rules)

    if (lines.length > 0) {
      ctx.systemSections.push({ id: 'project-rules', content: lines.join('\n'), priority: 30 })
    }
    return ctx
  },
}

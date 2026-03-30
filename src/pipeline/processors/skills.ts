import type { SkillEntry } from '../../prompt/skill-scanner.js'
import type { Processor } from '../types.js'

/**
 * Injects available skills into the executor system prompt.
 * State key: skills
 */
export const SkillsProcessor: Processor = {
  id: 'skills',
  order: 70,
  roles: ['executor'],
  async process(ctx) {
    const skills = (ctx.state.get('skills') as SkillEntry[]) || []
    if (skills.length === 0) return ctx

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

    const content = [
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
    ].join('\n')

    ctx.systemSections.push({ id: 'skills', content, priority: 70 })
    return ctx
  },
}

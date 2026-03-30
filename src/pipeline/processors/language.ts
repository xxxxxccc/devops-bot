import type { Processor } from '../types.js'

/**
 * Injects output language constraints.
 * State key: language
 */
export const LanguageProcessor: Processor = {
  id: 'language',
  order: 110,
  roles: ['dispatcher', 'executor', 'reviewer'],
  async process(ctx) {
    const language = ctx.state.get('language') as string | undefined
    if (!language) return ctx

    const content = [
      '',
      '## Output Language',
      '',
      `The user communicates in **${language}**.`,
      'All human-facing output MUST be in the same language:',
      '- Commit messages',
      '- PR title and description',
      '- submit_summary thinking',
      'Code comments and variable names remain in English.',
    ].join('\n')

    ctx.systemSections.push({ id: 'language', content, priority: 110 })
    return ctx
  },
}

import type { Processor } from '../types.js'

/**
 * Injects memory summary and detailed context into the user prompt.
 * State keys: memorySummary, detailedMemoryContext, memoryAvailable, projectContext
 */
export const MemoryProcessor: Processor = {
  id: 'memory',
  order: 40,
  roles: ['dispatcher'],
  async process(ctx) {
    const projectContext = ctx.state.get('projectContext') as string | undefined
    if (projectContext) {
      ctx.userSections.push({ id: 'project-context', content: projectContext, priority: 10 })
    }

    const memorySummary = ctx.state.get('memorySummary') as string | undefined
    if (memorySummary && memorySummary !== '(no relevant memories found)') {
      ctx.userSections.push({
        id: 'memory-summary',
        content: `## Relevant Memory Summaries\n${memorySummary}`,
        priority: 20,
      })
    }

    const detailed = ctx.state.get('detailedMemoryContext') as string | undefined
    if (detailed && detailed !== '(no relevant memories found)') {
      ctx.userSections.push({
        id: 'memory-detailed',
        content: `## Detailed Memories\n${detailed}`,
        priority: 25,
      })
    }

    const memoryAvailable = ctx.state.get('memoryAvailable') as boolean | undefined
    if (memoryAvailable) {
      const memorySection = [
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
      ].join('\n')
      ctx.systemSections.push({ id: 'memory-system', content: memorySection, priority: 40 })
    }

    return ctx
  },
}

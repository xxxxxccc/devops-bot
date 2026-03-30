import type { Processor } from '../types.js'

const JIRA_SECTION = [
  '',
  '## Jira Integration',
  '',
  'Jira issue links were detected in the task description. The following tools are available:',
  '',
  '- `jira_get_issue`: Get issue details by key (e.g., PROJ-123)',
  '- `jira_search`: Search issues with JQL',
  '- `jira_add_comment`: Add comment to an issue',
  '- `jira_update_issue`: Update issue fields',
  '- `jira_transition_issue`: Change issue status',
  '',
  '**Workflow**: Use `jira_get_issue` to fetch full issue details before starting.',
  'This will give you acceptance criteria, related issues, and more context.',
].join('\n')

const FIGMA_SECTION = [
  '',
  '## Figma Integration',
  '',
  'Figma design links were detected in the task description. The following tools are available:',
  '',
  '- `get_design_context`: Get UI code and design context from Figma node (extract fileKey and nodeId from URL)',
  '- `get_screenshot`: Get screenshot of a Figma node',
  '- `get_metadata`: Get metadata of a Figma file',
  '- `get_variable_defs`: Get design tokens/variables from Figma',
  '',
  '**Workflow**: Use `get_design_context` to fetch design details and generate UI code.',
  'Extract fileKey and nodeId from the Figma URL (e.g., https://figma.com/design/:fileKey/:name?node-id=:nodeId).',
  'For nodeId, convert format from URL (1-2) to API format (1:2).',
].join('\n')

/**
 * Injects Jira/Figma integration sections into the executor system prompt.
 * State keys: taskHasJira, taskHasFigma
 */
export const IntegrationProcessor: Processor = {
  id: 'integration',
  order: 100,
  roles: ['executor'],
  async process(ctx) {
    const hasJira = ctx.state.get('taskHasJira') as boolean | undefined
    const hasFigma = ctx.state.get('taskHasFigma') as boolean | undefined

    if (hasJira) {
      ctx.systemSections.push({ id: 'jira', content: JIRA_SECTION, priority: 100 })
    }
    if (hasFigma) {
      ctx.systemSections.push({ id: 'figma', content: FIGMA_SECTION, priority: 101 })
    }
    return ctx
  },
}

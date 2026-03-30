import type { Processor } from '../types.js'

interface SandboxConfig {
  branchName: string
  baseBranch: string
  submodules?: string[]
}

/**
 * Injects sandbox constraints into the executor system prompt.
 * State key: sandbox
 */
export const SandboxProcessor: Processor = {
  id: 'sandbox',
  order: 80,
  roles: ['executor'],
  async process(ctx) {
    const sandbox = ctx.state.get('sandbox') as SandboxConfig | undefined

    if (sandbox) {
      const lines = [
        '',
        '## Constraints (Sandbox Mode)',
        '',
        `- You are working in an **isolated sandbox branch**: \`${sandbox.branchName}\``,
        `- Base branch: \`${sandbox.baseBranch}\` — your changes will become a PR against this branch`,
        '- After finishing all changes and verification, **commit your work** using the format described in the Workflow section',
        '- Commit message must include `Requested-by:` trailer and a brief problem summary in the body',
        '- Do NOT push to remote — the system handles push and PR creation automatically',
        '- Do NOT create additional branches — stay on the current sandbox branch',
        '- Make minimal, focused changes',
        '- Ensure all type checks and lint checks pass before committing',
        '- You MUST call `submit_summary` at the end',
        '- Follow the project rules if provided',
        '- If unsure about something, explain your uncertainty',
      ]

      if (sandbox.submodules && sandbox.submodules.length > 0) {
        lines.push(
          '',
          '### Submodule Handling',
          '',
          'This project uses git submodules. The following paths are submodules:',
          ...sandbox.submodules.map((p) => `- \`${p}\``),
          '',
          '**If you modify files inside a submodule:**',
          '1. `cd` into the submodule directory first',
          '2. Stage and commit changes there (`git_add` + `git_commit` inside the submodule path)',
          '3. Then go back to the project root and stage the updated submodule reference (`git_add` the submodule path)',
          '4. Commit in the parent repo — the commit message should mention the submodule update',
          '',
          '**If you only modify files outside submodules**, just commit normally.',
        )
      }

      ctx.systemSections.push({ id: 'sandbox', content: lines.join('\n'), priority: 80 })
    } else {
      const content = [
        '',
        '## Constraints',
        '',
        '- Do NOT create new branches (work directly on current branch)',
        '- Do NOT commit changes (human will review and commit)',
        '- Do NOT push to remote',
        '- Make minimal, focused changes',
        '- Ensure all type checks and lint checks pass before finishing',
        '- You MUST call `submit_summary` at the end',
        '- Follow the project rules if provided',
        '- If unsure about something, explain your uncertainty',
      ].join('\n')

      ctx.systemSections.push({ id: 'sandbox', content, priority: 80 })
    }

    return ctx
  },
}

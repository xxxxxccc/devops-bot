/**
 * Shared prompt sections — building blocks used by both Layer 1 (dispatcher)
 * and Layer 2 (executor) system prompts.
 *
 * Each function returns a string[] of lines.  Empty array = section skipped.
 * Caller assembles with: sections.flat().join('\n')
 */

/* ------------------------------------------------------------------ */
/*  Identity                                                           */
/* ------------------------------------------------------------------ */

export function buildIdentitySection(role: 'dispatcher' | 'executor'): string[] {
  if (role === 'dispatcher') {
    return [
      '# DevOps Team AI',
      '',
      '## Identity',
      '',
      "You are a reliable DevOps engineer in the team's Chat group.",
      'You deeply understand the project through codebase scanning, accumulated memory,',
      'and its development conventions — and help the team ship fast without breaking things.',
      'You are not a generic chatbot — you are a technical team member who happens to be AI.',
      '',
      '## Values',
      '',
      '- **Honest and direct** — if a request is risky, unclear, or a bad idea, say so plainly',
      '- **Proactive** — point out potential risks, side effects, and suggest alternatives',
      '- **No blind agreement** — question vague or ambiguous requirements before acting',
      '- **Protect the team** — destructive or irreversible changes need explicit confirmation',
      '- **Concise** — this is a team chat, not documentation; keep replies short and actionable',
    ]
  }

  // executor
  return [
    '# AI DevOps Agent',
    '',
    'You are an AI DevOps agent. Your mission is to complete development tasks by:',
    '1. Understanding the requirement or bug',
    '2. Finding and analyzing relevant code',
    '3. Making necessary changes',
    '4. Submitting a summary of your work',
  ]
}

/* ------------------------------------------------------------------ */
/*  Safety                                                             */
/* ------------------------------------------------------------------ */

export function buildSafetySection(): string[] {
  return [
    '',
    '## Safety Boundaries',
    '',
    '- **Secrets & credentials**: NEVER include tokens, passwords, API keys, or .env contents in any output',
    '- **Destructive operations**: Mass deletion, force push, drop tables, removing critical files — require extreme caution and explicit confirmation',
    '- **Production / protected branches**: NEVER force push or directly modify production/main/master branches without explicit instruction',
  ]
}

/* ------------------------------------------------------------------ */
/*  Project Rules (from target project's AGENTS.md / CLAUDE.md)        */
/* ------------------------------------------------------------------ */

/** Max characters for injected project rules (executor). ~2000 tokens. */
const MAX_RULES_CHARS = 8000

/**
 * Full project rules injection for the executor (Layer 2).
 * Includes the entire AGENTS.md / CLAUDE.md content with a token budget.
 */
export function buildProjectRulesSection(rulesContent: string): string[] {
  if (!rulesContent) return []
  const truncated =
    rulesContent.length > MAX_RULES_CHARS
      ? `${rulesContent.slice(0, MAX_RULES_CHARS)}\n\n...(truncated, use \`read_file\` on AGENTS.md for full content)`
      : rulesContent
  return [
    '',
    '## Project Development Guide',
    '',
    "The following is the target project's development guide (from AGENTS.md / CLAUDE.md).",
    'It contains coding conventions, style rules, API patterns, and project-specific constraints.',
    'Follow these when writing or modifying code:',
    '',
    truncated,
  ]
}

/**
 * Lightweight summary for the dispatcher (Layer 1).
 * The dispatcher only classifies intent — it doesn't need code style details.
 */
export function buildProjectRulesSummary(rulesContent: string): string[] {
  if (!rulesContent) return []
  const overview =
    rulesContent
      .split('\n')
      .find((l) => l.trim() && !l.startsWith('#'))
      ?.trim()
      .slice(0, 200) || ''
  return [
    '',
    '## Project Conventions',
    '',
    'The target project has coding conventions documented in its AGENTS.md / CLAUDE.md.',
    ...(overview ? [`Overview: ${overview}`] : []),
    'When creating task descriptions, reference these conventions so the Task AI follows them.',
  ]
}

/* ------------------------------------------------------------------ */
/*  Runtime                                                            */
/* ------------------------------------------------------------------ */

export function buildRuntimeSection(): string[] {
  const now = new Date()
  return [
    '',
    '## Runtime',
    '',
    `- Current date: ${now.toISOString().split('T')[0]}`,
    `- Current time (UTC): ${now.toISOString()}`,
  ]
}

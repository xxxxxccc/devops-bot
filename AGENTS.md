# DevOps Bot

Chat-driven AI coding agent. Users communicate via IM group chat (Feishu or Slack), a two-layer AI system classifies intent and executes code changes automatically. Supports multiple AI providers (Anthropic, OpenAI, OpenAI-compatible).

## Commands

| Task | Command |
|------|---------|
| Dev (hot reload) | `pnpm dev` |
| Build | `pnpm build` |
| Start | `pnpm start` |
| Lint + Format check | `pnpm check` |
| Lint only | `pnpm lint` |
| Format (write) | `pnpm format` |

**Always run `pnpm check` before committing.**

## Critical Conventions

- **ESM + NodeNext**: All imports must use `.js` extension (e.g., `import { foo } from './bar.js'`)
- **Node.js builtins**: Use `node:` protocol (e.g., `import { readFile } from 'node:fs/promises'`)
- **Biome** for formatting and linting — not ESLint, not Prettier
- **Single quotes**, no semicolons, trailing commas (enforced by Biome)
- **pnpm** as package manager — do not use npm or yarn
- **No new dependencies** without justification; prefer Node.js builtins

## Project Context

- Supports **multi-project mode** — projects added via chat (`add_project` intent), auto-cloned to `~/.devops-bot/repos/`
- Falls back to **single-project mode** if `TARGET_PROJECT_PATH` is set
- IM bot (Feishu or Slack) is the **primary user interface** — there is no web frontend
- Two AI layers: **fast model** (dispatcher) and **powerful model** (task executor) — provider-agnostic
- **Three-tier task execution**: `execute_task` (low risk, immediate), `propose_task` (medium risk, needs approval via Issue AI synthesis), `create_issue` (high risk, discussion only)
- **PR Review**: AI-powered code review via `review_pr` intent, self-review after task completion (with auto-fix loop — up to 2 rounds), or polling/webhook triggers; Memory namespace isolation (`task` vs `review`) with selective cross-injection; full PR discussion context (issue comments + review summaries) injected into review and fix prompts
- **Issue AI**: Independent AI layer that reads full issue context (body + comments) and synthesizes actionable tasks; also scans external issues with configured labels
- **GitHub App authentication** for GitHub operations (PRs, Issues, git push); PAT fallback supported
- Skills stored at **workspace level** (`~/.devops-bot/skills/`), shared across all projects
- Memory persists in `data/memory/` using **SQLite** (primary) + **JSONL** exports (AI browsing)
- Configuration lives in `.env.local` (never committed)

## Security Rules

- **NEVER** commit `.env`, `.env.local`, API keys, or GitHub App private keys
- Shell tool blocks dangerous commands (`rm -rf /`, `sudo`, `shutdown`, etc.)
- Git operations must not force push or delete protected branches
- Validate all external inputs before processing
- All AI-generated changes stay on working branch — human reviews before merge
- GitHub App private keys must be stored securely outside the repository

## Detailed Guidelines

- [Architecture & Data Flow](.agents/architecture.md) — two-layer AI, modules, platform abstraction
- [Memory System](.agents/memory-system.md) — SQLite + JSONL storage, conversation splitting, AI browsing
- [Code Conventions](.agents/code-conventions.md) — TypeScript patterns, Biome rules, file structure
- GitHub App auth: `src/github/app-auth.ts`, `src/github/client.ts`
- Multi-project: `src/project/registry.ts`, `src/project/repo-manager.ts`, `src/project/resolver.ts`
- Issue AI & Approval: `src/approval/issue-ai.ts`, `src/approval/poller.ts`, `src/approval/store.ts`
- PR Review: `src/review/engine.ts`, `src/review/ai-client.ts`, `src/review/diff-parser.ts`, `src/review/poller.ts`
- Auto-fix loop: `src/webhook/task-runner.ts` (`selfReviewAndFix`), `src/webhook/prompt.ts` (`buildReviewFixPrompt`), `src/sandbox/manager.ts` (`createSandboxOnBranch`)

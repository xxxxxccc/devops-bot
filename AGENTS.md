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

- This tool operates on a **separate target project** at `TARGET_PROJECT_PATH`
- IM bot (Feishu or Slack) is the **primary user interface** — there is no web frontend
- Two AI layers: **fast model** (dispatcher) and **powerful model** (task executor) — provider-agnostic
- AI providers configured via `AI_PROVIDER` + `AI_API_KEY` (supports Anthropic, OpenAI, and compatible APIs)
- IM platform configured via `IM_PLATFORM` (supports `feishu` and `slack`)
- Memory persists in `data/memory/` using **SQLite** (primary) + **JSONL** exports (AI browsing)
- Configuration lives in `.env.local` (never committed)

## Security Rules

- **NEVER** commit `.env`, `.env.local`, or API keys
- Shell tool blocks dangerous commands (`rm -rf /`, `sudo`, `shutdown`, etc.)
- Git operations must not force push or delete protected branches
- Validate all external inputs before processing
- All AI-generated changes stay on working branch — human reviews before merge

## Detailed Guidelines

- [Architecture & Data Flow](.agents/architecture.md) — two-layer AI, modules, platform abstraction
- [Memory System](.agents/memory-system.md) — SQLite + JSONL storage, conversation splitting, AI browsing
- [Code Conventions](.agents/code-conventions.md) — TypeScript patterns, Biome rules, file structure

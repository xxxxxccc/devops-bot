# Contributing to DevOps Bot

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/xxxxxccc/devops-bot.git
cd devops-bot

# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env.local
# Edit .env.local with your API keys

# Start development server (hot reload)
pnpm dev
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for formatting and linting.

- **Single quotes**, no semicolons, trailing commas
- **ESM + NodeNext**: all imports must use `.js` extension
- **Node.js builtins**: use `node:` protocol (e.g., `import { readFile } from 'node:fs/promises'`)

Before committing, always run:

```bash
pnpm check
```

To auto-fix formatting:

```bash
pnpm format
```

## Making Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run checks: `pnpm check && pnpm build`
5. Commit with a clear message
6. Push and open a Pull Request

## Commit Messages

Use clear, descriptive commit messages:

- `feat: add Slack bot integration` — new feature
- `fix: handle empty task description` — bug fix
- `refactor: simplify memory retrieval pipeline` — code improvement
- `docs: update API reference` — documentation

## Adding Dependencies

- Prefer Node.js builtins over third-party packages
- New dependencies require justification in the PR description
- Use `pnpm add` (not npm or yarn)

## Adding MCP Tools

Tools are defined in `src/tools/`. To add a new tool:

1. Create or edit a file in `src/tools/`
2. Use `defineTool(...)` to define the tool with a Zod schema
3. Register it in the appropriate tool array
4. Update `src/core/tool-policy.ts` with the new tool's category

## Reporting Issues

When reporting bugs, please include:

- Steps to reproduce
- Expected vs actual behavior
- Node.js version (`node -v`)
- OS and version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

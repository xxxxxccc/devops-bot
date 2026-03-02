# Skills

Bundled skills for the DevOps Bot executor (Layer 2). Each skill provides
domain-specific guidance that the AI agent can load on demand.

## How it works

Skills are loaded from two locations with priority-based merging:

1. **Bundled skills** (`devops-bot/skills/`) — shipped with the bot installation
2. **Workspace skills** (`~/.devops-bot/skills/`) — user-installed, higher priority

At startup, the skill scanner reads both directories. Each skill's `name` and
`description` (from YAML frontmatter) are injected into the executor system
prompt as a compact list. Before starting a task, the executor scans
descriptions and decides whether a skill applies. If it does, the executor
reads the full `SKILL.md` via `read_file` and follows its instructions.

When the same skill name exists in both locations, the workspace version wins.

## Adding a new skill

Create a subdirectory with a `SKILL.md` file in the workspace skills directory:

```
~/.devops-bot/skills/
└── my-skill/
    ├── SKILL.md          # Required — frontmatter + instructions
    ├── references/       # Optional — extra docs the AI can read
    └── scripts/          # Optional — helper scripts
```

You can also use the `create_skill` tool via chat to create skills interactively.

### SKILL.md format

```markdown
---
name: my-skill
description: One-line description of what this skill does and when to use it.
---

# My Skill

Full instructions for the AI agent. Include:
- When to apply this skill
- Step-by-step guidance
- Code examples and patterns
- Common pitfalls to avoid
```

**Required frontmatter fields:**

- `name` — Unique identifier (use kebab-case, e.g. `react-best-practices`)
- `description` — A single sentence describing **what** the skill does and
  **when** to use it. This is the only text the AI sees before deciding to
  load the full skill, so make it clear and specific.

## Design principles

- **Lazy loading** — Only `name` + `description` go into the prompt; full
  content is loaded on demand. This keeps the base prompt small.
- **One skill per task** — The executor reads at most one SKILL.md per task
  to avoid context pollution.
- **Self-contained** — Each skill should be usable without reading other skills.

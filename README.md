# DevOps Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PR Check](https://github.com/xxxxxccc/devops-bot/actions/workflows/pr-check.yml/badge.svg)](https://github.com/xxxxxccc/devops-bot/actions/workflows/pr-check.yml)
[![Release](https://github.com/xxxxxccc/devops-bot/actions/workflows/release.yml/badge.svg)](https://github.com/xxxxxccc/devops-bot/actions/workflows/release.yml)

Chat-driven AI coding agent — discuss requirements in group chat, get automated code changes and pull requests.

Supports multiple AI providers (Anthropic, OpenAI, and any OpenAI-compatible API) and multiple IM platforms (Feishu/Lark, Slack).

## Architecture

### System Overview

```mermaid
flowchart LR
    subgraph im [IM Platform]
        Msg["User Message\n(text + images + links)"]
    end

    subgraph parse [Message Parser]
        Parser["Download attachments\nExtract links\nParse text"]
    end

    subgraph layer1 [Layer 1 - Smart Dispatcher]
        Router["Intent Router AI\n(fast model, single-turn)"]
        Memory["Memory Store"]
    end

    subgraph layer2 [Layer 2 - Executors]
        ChatReply["Chat Reply"]
        MemoryQuery["Memory Query"]
        TaskExec["DevOps Task Executor\n(powerful model, multi-turn + MCP)"]
    end

    Msg -->|"WebSocket / Socket"| Parser
    Parser --> Router
    Router -->|"chat"| ChatReply
    Router -->|"query_memory"| MemoryQuery
    Router -->|"execute_task"| TaskExec
    Router -->|"propose_task"| TaskExec
    Router -->|"create_issue"| TaskExec
    Router -->|"review_pr"| ReviewAI["PR Review AI\n(TASK_MODEL)"]
    Router -->|"add_project / add_workspace"| TaskExec
    Router <-->|"read/write"| Memory
    MemoryQuery <-->|"retrieve"| Memory
    TaskExec -->|"enriched description"| Executor["AIExecutor"]
    ChatReply -->|"reply"| Msg
    MemoryQuery -->|"reply"| Msg
    TaskExec -->|"status update"| Msg
    Executor -->|"task desc + summary"| Memory
    ReviewAI -->|"review result"| Msg
    ReviewAI -->|"review feedback"| Memory
```

### Memory Feedback Loop

```mermaid
flowchart TB
    subgraph input [Task Input]
        TaskDesc["Task Description\n(title + description)"]
        TaskMeta["Task Metadata\n(createdBy, attachments, jira link)"]
    end

    subgraph exec [Task Execution]
        AI["AIExecutor"]
    end

    subgraph output [Task Output]
        Summary["Task Summary\n(thinking + modified_files)"]
        Error["Task Error\n(if failed)"]
    end

    subgraph memory [Memory Store]
        TaskInput_Mem["task_input\n(what was requested)"]
        TaskResult_Mem["task_result\n(what was done)"]
        Decision_Mem["decision\n(extracted decisions)"]
        Issue_Mem["issue\n(discovered issues)"]
    end

    TaskDesc --> AI
    TaskMeta --> AI
    AI --> Summary
    AI --> Error

    TaskDesc -->|"on task created"| TaskInput_Mem
    Summary -->|"on task completed"| TaskResult_Mem
    Summary -->|"AI extract"| Decision_Mem
    Error -->|"AI extract"| Issue_Mem
```

## Three-Tier Task Execution

The dispatcher AI assesses risk level and routes tasks through three tiers:

```mermaid
flowchart TD
  msg["User Message"] --> ai["Dispatcher AI\n(risk assessment)"]
  ai -->|"Low risk"| tier1["Tier 1: execute_task\nImmediate execution"]
  ai -->|"Medium risk"| tier2["Tier 2: propose_task\nIssue + approval"]
  ai -->|"High risk / unclear"| tier3["Tier 3: create_issue\nDiscussion only"]

  tier1 --> exec1["Execute + Create Issue\n+ PR links to Issue"]
  tier2 --> issue2["Create Issue\n(wait for ✅ reaction)"]
  issue2 -->|"Approved"| exec2["Execute Task"]
  tier3 --> issue3["Create Issue\n(human discussion)"]
```

### Tier 1: `execute_task` (Low Risk)

Executes immediately without human approval. Best for:
- Copy/text updates, config tweaks
- Simple bug fixes with clear scope
- Style adjustments, typo fixes

An Issue is auto-created for tracking, and the resulting PR links to it.

### Tier 2: `propose_task` (Medium Risk)

Creates an Issue and waits for approval before executing. A background poller checks for approval reactions (`+1`, `heart`, or `hooray`) every 30 minutes (configurable via `APPROVAL_POLL_INTERVAL_MS`). When approved, an independent **Issue AI** (using the Dispatcher model) reads the full issue discussion and synthesizes a clear, actionable task description -- filtering out meta-discussion and focusing on the latest consensus. The synthesized task is then executed by the Task AI. Used for:
- New features
- Refactoring across multiple files
- Adding dependencies
- Multi-module changes

### External Issue Support

The poller also scans all registered projects for open issues labeled `devops-bot` (configurable via `ISSUE_SCAN_LABELS`). Any issue with an approval reaction is processed by the Issue AI the same way. This means users can create issues directly on GitHub/GitLab, label them, and approve them -- no chat interaction required. The bot posts a comment on the issue when execution starts or when it determines the issue is not feasible for automated execution.

### Cross-Repo Triage (Workspace Mode)

When workspace context is available, the Issue AI uses a **two-phase cross-repo triage** flow instead of the default single-phase synthesis:

**Phase 1 — Triage**: Quality gate + cross-repo routing
- Assesses if the issue is suitable for automated execution (verdict: `actionable` / `needs_info` / `reject`)
- Rejects issues with fabricated or hallucinated analysis (common in bot-generated issues)
- Determines which project(s) in the workspace should handle the issue
- Uses workspace context (project list + workspace `CLAUDE.md`)

**Phase 2 — Synthesis**: Per-repo task content generation
- Generates a targeted task description for each identified project
- When the target repo differs from the filing repo, creates a sub-issue in the target repo with a backlink to the original

Three issue discovery paths feed into this flow:

| Path | Source | Description |
|------|--------|-------------|
| **A** | Bot-created issues | `pending_approvals` table — issues created via `propose_task` |
| **B** | External issues | Project repos scanned for `ISSUE_SCAN_LABELS` label |
| **C** | Workspace issues | Workspace repo scanned; distributed to sub-projects via triage |

Key behaviors:
- Without workspace context, the legacy single-phase Issue AI behavior is unchanged
- Sub-issues created during triage are auto-approved (the original issue's approval covers all targets)
- The workspace repo itself is never a task target — issues filed there are always distributed to sub-projects

### Tier 3: `create_issue` (High Risk / Unclear)

Creates an Issue for discussion only — no automatic execution. Used for:
- Architecture changes
- Vague or open-ended requests
- Data migrations
- Breaking API changes

### Risk Assessment Criteria

The AI evaluates:
- **Specificity**: Is it clear exactly what to change?
- **Scope**: How many files/modules are affected?
- **Reversibility**: Can it be easily reverted?
- **Breaking potential**: Could it break existing functionality?
- **Design decisions**: Are there multiple valid approaches?

## PR Review

AI-powered code review that provides both high-level summary and line-level comments on pull requests. Uses the `TASK_MODEL` for review analysis.

### Trigger Modes

| Trigger | How it works | IM Notification |
|---------|-------------|-----------------|
| **Self-review** | Automatically reviews bot-created PRs after task completion (`ENABLE_SELF_REVIEW=true`). If critical/warning issues are found, triggers an **auto-fix loop** (up to 2 rounds) that pushes fixes to the same PR branch and re-reviews. | Yes (originating chat) |
| **IM command** | User sends "review PR #123" in chat → `review_pr` intent | Yes (originating chat) |
| **Polling** | Background poller scans registered projects for open PRs (`REVIEW_TRIGGER_MODE=polling`, default) | No (GitHub PR comment only) |
| **Webhook** | GitHub webhook on PR open/update (`REVIEW_TRIGGER_MODE=webhook`) | No (GitHub PR comment only) |

### Memory Isolation

Review memories are stored in a separate `review` namespace to avoid polluting task context. Two review-specific memory types are used:

- **`review_feedback`** — per-PR review results
- **`review_pattern`** — recurring patterns extracted across reviews

When `ENABLE_REVIEW_CROSS_INJECT=true`, `review_pattern` memories are selectively injected into task dispatcher context, creating a feedback loop where common review findings improve future code generation.

### Auto-Fix Loop (Self-Review Only)

When self-review detects critical or warning issues, it automatically attempts to fix them:

1. **Review** — ReviewEngine analyzes the PR, posts GitHub review comments
2. **Fix** — Creates a sandbox on the existing PR branch, AI fixes critical/warning issues, pushes to the same branch
3. **Re-review** — Reviews the fixed PR again; if issues remain, repeats step 2
4. **Max 2 rounds** — Hard limit prevents infinite loops; after 2 fix rounds, stops regardless of remaining issues

Safety measures:
- Verifies PR is still open before each fix attempt (skips if merged/closed)
- Fetches full PR discussion context (issue comments + review summaries) as additional fix context
- Only triggers for self-review (bot-created PRs); external reviews only post comments

Controlled by `ENABLE_SELF_REVIEW=true` — no additional configuration needed.

## Workspace Mode

Instead of registering individual projects one by one, you can register a single **workspace meta-repo** that describes all your organization's projects. The dispatcher AI reads the manifest and selects the correct sub-project per task, cloning on demand.

### Setup

1. Create a `workspace.json` in your workspace repo root:

```json
{
  "defaultBranch": "dev",
  "projects": [
    {
      "id": "my-app",
      "gitUrl": "git@github.com:org/my-app.git",
      "branch": "dev",
      "lang": "TypeScript",
      "description": "Main web application"
    },
    {
      "id": "my-api",
      "gitUrl": "git@github.com:org/my-api.git",
      "branch": "dev",
      "lang": "Go",
      "description": "Backend API service"
    }
  ]
}
```

2. Optionally add a `CLAUDE.md` with development guidelines, conventions, and project relationships — injected into the dispatcher AI as context.

3. In chat, say: `add workspace https://github.com/org/my-workspace`

### How It Works

- The dispatcher AI sees all sub-projects from the manifest and workspace guidelines
- When a task targets a sub-project, the system clones it on demand (lazy)
- Sub-projects are registered in the same `projects` table, reusing all existing task/review/approval infrastructure
- The workspace's `branch` field overrides auto-detected default branches (e.g. `dev` instead of `main`)
- Already-cloned sub-projects are synced, not re-cloned

### Workspace vs Multi-Project

| Mode | Registration | When to use |
|------|-------------|-------------|
| **Single-project** | `TARGET_PROJECT_PATH` env var | One repo, simple setup |
| **Multi-project** | `add project <URL>` per repo | Few repos, manual control |
| **Workspace** | `add workspace <URL>` once | Many repos, org-wide AI agent |

## Features

- **Multi-provider AI**: Anthropic (Claude), OpenAI, or any OpenAI-compatible API (DeepSeek, Groq, Together, etc.)
- **Multi-platform IM**: Feishu/Lark (WebSocket) or Slack (Socket Mode) — no public IP needed
- **Two-Layer AI**: Fast model routes intents, powerful model executes tasks — cost optimized
- **Project Memory**: AI remembers decisions, context, and past work
- **Sandbox Execution**: Tasks run in isolated Git worktree sandboxes, changes submitted as Draft PRs
- **Parallel Execution**: Per-project serial, cross-project parallel task execution (configurable concurrency)
- **Multi-Project**: Manage multiple git repositories from a single chat group
- **Workspace Mode**: Register a workspace meta-repo (`workspace.json`) to manage all org sub-projects from one entry point, with on-demand cloning
- **GitHub App Auth**: Secure authentication via GitHub App (replaces PAT)
- **Three-Tier Tasks**: AI-driven risk assessment routes tasks through execute/propose/issue tiers
- **PR Review**: AI code review with self-review (+ auto-fix loop), IM command, polling, and webhook triggers
- **Jira Integration**: Auto-fetch issue details when Jira link detected
- **Figma Integration**: Fetch design context from Figma links
- **File Attachments**: Screenshots and files from IM messages are passed to Task AI

## Prerequisites

| Dependency | Required | Purpose |
|-----------|----------|---------|
| **Node.js ≥ 18** or **Bun** | Yes | Runtime environment |
| **git** | Yes | Repository management, branch/commit/push operations |
| **curl** or **wget** | Yes | Download release artifacts during install |
| **Python 3** | Recommended | Required by `node-gyp` to compile native modules (`better-sqlite3`, `node-pty`) |
| **make + gcc/g++** | Recommended | C/C++ build toolchain for native modules |

<details>
<summary>Install commands by platform</summary>

**Debian / Ubuntu**
```bash
sudo apt update && sudo apt install -y git curl python3 make g++
# Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**RHEL / Amazon Linux**
```bash
sudo yum install -y git curl python3 make gcc-c++
# Node.js (via NodeSource)
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs
```

**macOS**
```bash
# Xcode command line tools (includes git, make, clang)
xcode-select --install
# Node.js (via Homebrew)
brew install node
```

**Any platform (via nvm)**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22
```
</details>

> **Note:** Pre-built binaries for native modules are bundled in release artifacts.
> Python and build tools are only needed if pre-built binaries are unavailable for your platform.

## Quick Start

### Option 1: One-line Install (Recommended)

```bash
# Interactive mode (recommended for first-time setup)
bash <(curl -fsSL https://raw.githubusercontent.com/xxxxxccc/devops-bot/main/install.sh)

# Or non-interactive (install with defaults, configure .env.local manually)
curl -fsSL https://raw.githubusercontent.com/xxxxxccc/devops-bot/main/install.sh | bash
```

> **Note:** The interactive mode (`bash <(...)`) is recommended for first-time installs,
> as it guides you through AI provider, project path, and IM platform configuration.
> The piped mode (`curl ... | bash`) will install with defaults and skip the setup wizard.

The installer will:
- Download the latest pre-built release from GitHub
- Detect your runtime (Node.js ≥ 18 or Bun)
- Guide you to configure AI provider, project path, and IM platform (interactive mode)
- Optionally configure Jira, Figma, and local vector search
- Set up `devops-bot` command globally

Then start:
```bash
devops-bot start
```

Upgrade anytime:
```bash
devops-bot upgrade
```

### Option 2: Manual Install (Development)

```bash
git clone https://github.com/xxxxxccc/devops-bot.git
cd devops-bot
pnpm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Single-project mode (backward compatible):
# TARGET_PROJECT_PATH=/path/to/your/project

# Multi-project mode: projects added via chat ("add project <git URL>")
# Workspace mode: "add workspace <git URL>" for meta-repo with workspace.json
# No TARGET_PROJECT_PATH needed

# GitHub App (recommended for GitHub repos):
# GITHUB_APP_ID=123456
# GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem

# AI provider: anthropic | openai (default: anthropic)
# AI_PROVIDER=anthropic
AI_API_KEY=your-api-key

# IM platform: feishu | slack (default: feishu)
# IM_PLATFORM=feishu

# Feishu
FEISHU_APP_ID=your-feishu-app-id
FEISHU_APP_SECRET=your-feishu-app-secret

# Or Slack
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
```

Build and start:
```bash
pnpm build
pnpm start
```

### Prerequisites

1. **AI API Key** — pick one:
   - [Anthropic Console](https://console.anthropic.com/) for Claude models
   - [OpenAI Platform](https://platform.openai.com/api-keys) for GPT models
   - Any OpenAI-compatible endpoint (DeepSeek, Groq, Together, etc.) via `AI_BASE_URL`

2. **IM Platform** — pick one:
   - **Feishu/Lark**: Create app at https://open.feishu.cn/app → Enable Long Connection → Add `im.message.receive_v1` event
   - **Slack**: Create app at https://api.slack.com/apps → Enable Socket Mode → Subscribe to message events

### CLI Commands

```bash
devops-bot start            # Start the server (IM bot auto-connects)
devops-bot start -p 8080    # Custom port
devops-bot --project /path  # Specify project path
devops-bot tools            # List available MCP tools
devops-bot mcp              # Start MCP server (stdio)
devops-bot setup-embedding  # Install local embedding model for vector search
devops-bot upgrade          # Upgrade to latest version
devops-bot migrate-tasks    # Import legacy tasks.json into memory
devops-bot --help           # Show help
```

## How It Works

1. **Send a message** in your IM group chat (e.g., "Fix the timezone display bug in settings")
2. **Layer 1 (Dispatcher)** classifies intent → routes to task creation
3. **Layer 2 (Task AI)** analyzes code, makes changes in a sandbox, runs checks
4. **Task complete** → IM receives summary with modified files, Draft PR created

The system remembers past decisions, user preferences, and task history for context.

## API Reference

All write APIs require auth header:

```bash
secret: your-secret-key
# or
Authorization: Bearer your-secret-key
```

### Health Check
```bash
GET /health
```

### SSE
```bash
GET /events
POST /watch
```

### Submit Task (API)
```bash
POST /task
Content-Type: application/json

{
  "title": "Fix timezone display bug",
  "task": "The timezone shows Belize instead of Chicago..."
}
```

### Get Task
```bash
GET /task/:id
```

### List Tasks
```bash
GET /tasks
```

### Update / Delete Task
```bash
PATCH /task/:id
DELETE /task/:id
```

### Task Actions
```bash
POST /task/:id/retry
POST /task/:id/stop
POST /task/:id/continue
```

### Upload Attachments
```bash
POST /upload
Content-Type: multipart/form-data
```

### GitHub Webhook (PR Review)
```bash
POST /webhook/github
Content-Type: application/json

# Receives GitHub pull_request events (opened, synchronize)
# Requires REVIEW_TRIGGER_MODE=webhook or both
```

### Other Endpoints
```bash
GET /tools
POST /webhook/todo
```

## MCP Tools

| Category | Tools |
|----------|-------|
| **File** | `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory` |
| **Search** | `glob_search`, `grep_search` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_show`, `git_branch`, `git_checkout_branch`, `git_switch`, `git_add`, `git_commit`, `git_push`, `git_pull`, `git_stash` |
| **Shell** | `shell_exec`, `shell_stream`, `npm` |
| **Task** | `submit_summary`, `get_task_history` |
| **Jira** | `jira_get_issue`, `jira_search`, `jira_add_comment`, `jira_update_issue` (when configured) |
| **Figma** | `get_design_context`, `get_screenshot`, `get_metadata`, `get_variable_defs` (when configured) |

## Project Structure

```
devops-bot/
├── src/
│   ├── index.ts              # Entry point, CLI commands
│   ├── providers/
│   │   ├── types.ts          # AIProvider interface, neutral message types
│   │   ├── anthropic.ts      # Anthropic (Claude) adapter
│   │   ├── openai.ts         # OpenAI / compatible API adapter
│   │   └── index.ts          # Provider factory
│   ├── channels/
│   │   ├── types.ts          # IMPlatform interface, neutral message types
│   │   ├── feishu/           # Feishu/Lark adapter (WebSocket, parser, types)
│   │   ├── slack/            # Slack adapter (Socket Mode, Block Kit)
│   │   └── index.ts          # Platform factory
│   ├── agent/
│   │   ├── ai-executor.ts    # Provider-agnostic AI executor with MCP
│   │   └── create-executor.ts # Executor factory
│   ├── dispatcher/
│   │   ├── index.ts          # Layer 1 orchestrator (platform-agnostic)
│   │   ├── ai-client.ts      # Dispatcher model call + tool loop
│   │   ├── prompt.ts         # Dispatcher prompt builder
│   │   ├── tools.ts          # Read-only dispatcher tools
│   │   └── config.ts         # Dispatcher memory config
│   ├── memory/
│   │   ├── store.ts          # SQLite-backed memory + JSONL export
│   │   ├── db.ts             # SQLite schema and queries
│   │   ├── search.ts         # Hybrid search (vector + keyword)
│   │   ├── embedding.ts      # Embedding provider integration
│   │   ├── extractor.ts      # AI-powered memory extraction
│   │   ├── retriever.ts      # Memory retrieval pipeline
│   │   ├── dedup.ts          # Memory dedup/reinforcement logic
│   │   └── types.ts          # Memory type definitions
│   ├── webhook/
│   │   ├── server.ts         # Webhook server composition
│   │   ├── routes.ts         # Express route handlers
│   │   ├── task-runner.ts    # Task queue + execution
│   │   ├── sse.ts            # SSE client manager
│   │   └── prompt.ts         # Layer 2 prompt builder
│   ├── sandbox/
│   │   ├── manager.ts        # Git worktree sandbox lifecycle
│   │   ├── pr-creator.ts     # Auto PR/MR creation (GitHub/GitLab)
│   │   └── issue-creator.ts  # Auto Issue creation (GitHub/GitLab)
│   ├── approval/
│   │   ├── store.ts          # SQLite-backed pending approval + processed issue storage (incl. workspace source)
│   │   ├── poller.ts         # Polling loop: check reactions, scan repos, workspace triage, sub-issue creation
│   │   └── issue-ai.ts       # Issue AI: triage (quality gate + cross-repo routing) + task synthesis
│   ├── review/
│   │   ├── engine.ts         # PR review orchestrator
│   │   ├── ai-client.ts      # Review AI calls (TASK_MODEL)
│   │   ├── diff-parser.ts    # Diff parsing and filtering
│   │   ├── prompt.ts         # Review prompt builder
│   │   ├── comment-builder.ts # GitHub/IM output formatting
│   │   ├── store.ts          # Reviewed PR deduplication
│   │   ├── poller.ts         # PR polling mechanism
│   │   └── types.ts          # Review type definitions
│   ├── attachment/
│   │   ├── index.ts           # createUploader() factory + uploadAttachments() helper
│   │   ├── uploader.ts        # AttachmentUploader interface + BaseUploader
│   │   ├── downloader.ts      # extractAndDownloadImages() from markdown discussions
│   │   └── providers/
│   │       ├── github-repo.ts # GitHub repo provider (Git Tree API batch commits)
│   │       ├── gitlab-uploads.ts # GitLab Project Uploads API
│   │       ├── s3.ts          # AWS S3 (dynamic import)
│   │       ├── local.ts       # Local HTTP static files
│   │       └── custom.ts      # Custom webhook endpoint
│   ├── github/
│   │   ├── app-auth.ts       # GitHub App JWT + installation token
│   │   └── client.ts         # Unified GitHub API client
│   ├── project/
│   │   ├── registry.ts       # SQLite-backed project registry
│   │   ├── repo-manager.ts   # Git clone/sync manager
│   │   ├── resolver.ts       # Project resolution orchestrator (+ workspace info helpers)
│   │   └── workspace.ts      # Workspace registry, manifest parser, context loader
│   ├── mcp/
│   │   └── server.ts         # MCP server for AI tools
│   ├── tools/
│   │   ├── index.ts          # Tool registry and registration
│   │   ├── file-tools.ts     # File operations
│   │   ├── git-tools.ts      # Git operations
│   │   ├── shell-tools.ts    # Shell commands
│   │   ├── platform-tools.ts # IM platform tools (send message, etc.)
│   │   ├── skill-tools.ts    # Skill management (find/install/create)
│   │   └── summary-tool.ts   # AI summary submission
│   ├── prompt/               # Project/rules/skills scanner
│   ├── types/                # Type declarations (node-llama-cpp, etc.)
│   ├── core/
│   │   ├── task-store.ts     # JSON-based task persistence
│   │   ├── registry.ts       # MCP tool registry
│   │   ├── tool-policy.ts    # Tool policy and grouping
│   │   └── types.ts          # TypeScript types
│   └── infra/                # Logger, retry helpers
├── skills/                   # Bundled skills for Task AI executor
├── models/                   # Local embedding models (optional)
├── data/
│   ├── tasks.json            # Task storage
│   ├── memory/
│   │   ├── index.sqlite      # Memory primary storage
│   │   ├── *.jsonl           # Memory exports for AI browsing
│   │   └── conversations/    # Conversation JSONL by month
│   └── attachments/          # Uploaded/downloaded files
├── ~/.devops-bot/              # Workspace directory
│   ├── repos/                  # Managed git clones (multi-project mode)
│   ├── skills/                 # Workspace-level user skills
│   └── data/                   # Debug logs
└── .env.local                # Configuration
```

## Safety

- Dangerous shell commands are blocked (`rm -rf /`, `sudo`, etc.)
- Task execution runs in isolated Git worktree sandboxes
- Changes are submitted as Draft PRs for human review
- Protected branches cannot be force-pushed
- PR reviews use memory namespace isolation to prevent cross-contamination
- Cost-optimized: fast model for routing, powerful model for execution

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

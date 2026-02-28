# Architecture & Data Flow

## Two-Layer AI System

### Layer 1 — Dispatcher (`src/dispatcher/index.ts`)

- **Model**: Fast model (`DISPATCHER_MODEL`, default `claude-sonnet-4-5-20250929`)
- **Mode**: Multi-round with **read-only tools** (file read/search profile)
- **Job**: Understand message intent, synthesize reply, or create task for Layer 2

Intents:
| Intent | Action |
|--------|--------|
| `chat` | Reply directly in IM |
| `query_memory` | Query memory and reply with context |
| `create_task` | Extract title/description, enrich with links/files, enqueue execution |

### Layer 2 — Task Executor (`src/agent/ai-executor.ts`)

- **Model**: Powerful model (`TASK_MODEL`, default `claude-opus-4-5-20251101`)
- **Mode**: Multi-turn MCP tool loop
- **Job**: Execute code changes on `TARGET_PROJECT_PATH`, then submit summary

Available tools come from `src/tools/` and can be augmented with Jira/Figma MCP when configured.

## Module Map

```
src/
├── index.ts                   # CLI entry + bootstrap (start/mcp/tools/upgrade/...)
├── providers/
│   ├── types.ts               # AIProvider interface, neutral message types
│   ├── anthropic.ts           # Anthropic (Claude) adapter
│   ├── openai.ts              # OpenAI / compatible API adapter
│   └── index.ts               # Provider factory (createProviderFromEnv)
├── channels/
│   ├── types.ts               # IMPlatform interface, neutral message types
│   ├── feishu/                # Feishu/Lark adapter (WebSocket, parser, types)
│   ├── slack/                 # Slack adapter (Socket Mode, Block Kit)
│   └── index.ts               # Platform factory (createPlatform)
├── agent/
│   ├── ai-executor.ts         # Provider-agnostic Layer 2 executor (AI + MCP)
│   ├── create-executor.ts     # Executor factory
│   └── timezone.ts
├── dispatcher/
│   ├── index.ts               # Layer 1 orchestrator (platform-agnostic)
│   ├── ai-client.ts           # Dispatcher model call + tool loop
│   ├── prompt.ts              # Dispatcher prompt builder
│   ├── tools.ts               # Read-only dispatcher tools
│   └── config.ts              # Memory injection config
├── webhook/
│   ├── server.ts              # Composition root
│   ├── routes.ts              # HTTP endpoints
│   ├── task-runner.ts         # FIFO queue + execution lifecycle
│   ├── sse.ts                 # SSE client management
│   └── prompt.ts
├── sandbox/
│   ├── manager.ts             # Git worktree sandbox lifecycle
│   └── pr-creator.ts          # Auto PR/MR creation (GitHub/GitLab)
├── memory/
│   ├── store.ts               # SQLite-backed memory + JSONL export
│   ├── db.ts                  # SQLite schema/queries + vec/fts
│   ├── search.ts              # Hybrid search (vector + keyword + salience)
│   ├── embedding.ts           # Local embedding + OpenAI fallback
│   ├── extractor.ts
│   ├── retriever.ts
│   ├── dedup.ts
│   └── types.ts
├── mcp/server.ts              # stdio MCP server
├── tools/                     # file/search/git/shell/task/skill tools
├── prompt/                    # project/rules/skills scanner
├── core/
│   ├── task-store.ts
│   ├── registry.ts
│   ├── tool-policy.ts
│   └── types.ts
└── infra/                     # logger/retry helpers
```

## Request Flow

```
IM message (Feishu WebSocket / Slack Socket Mode)
  -> channel adapter: parse text + attachments + links + sender
  -> debounce/merge:
       - @mention starts dispatch window (default 3s, max 15s)
       - follow-up attachments merged into one request
  -> dispatcher (Layer 1):
       - store conversation message
       - retrieve memory context (hybrid search)
       - call AI with read-only tools (provider-agnostic)
       - return intent (chat/query_memory/create_task)
       - send/update IM "thinking" card
  -> task-runner (for create_task):
       - enqueue FIFO (single task at a time)
       - execute Layer 2 with MCP in sandbox
       - stream output to SSE
       - update IM task card on completion/failure
       - create Draft PR for human review
       - write task_input/task_result/issue (+ extracted decisions) to memory
```

## IM Platform Abstraction

The `IMPlatform` interface (`src/channels/types.ts`) provides a common API:
- `connect()` / `disconnect()`
- `onMessage(handler)` — receive messages
- `sendText()` / `sendCard()` / `updateCard()` — send replies

Each platform adapter handles platform-specific details (WebSocket vs Socket Mode, card formats, etc.).

## AI Provider Abstraction

The `AIProvider` interface (`src/providers/types.ts`) provides a common API:
- `createMessage(params)` — send messages with tools support

Adapters translate between neutral types (`AIMessage`, `AIContentBlock`, `AIToolDefinition`) and vendor SDKs.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_API_KEY` | Yes | AI provider API key |
| `TARGET_PROJECT_PATH` | Yes | Target project path |
| `IM_PLATFORM` | No | IM platform: `feishu` \| `slack` (default: `feishu`) |
| `AI_PROVIDER` | No | AI provider: `anthropic` \| `openai` (default: `anthropic`) |
| `AI_BASE_URL` | No | Custom base URL for OpenAI-compatible endpoints |
| `TASK_MODEL` | No | Layer 2 model (default: `claude-opus-4-5-20251101`) |
| `DISPATCHER_MODEL` | No | Layer 1 model (default: `claude-sonnet-4-5-20250929`) |
| `MEMORY_MODEL` | No | Memory extractor model |
| `FEISHU_APP_ID` | If Feishu | Feishu bot App ID |
| `FEISHU_APP_SECRET` | If Feishu | Feishu bot App Secret |
| `SLACK_BOT_TOKEN` | If Slack | Slack bot token |
| `SLACK_APP_TOKEN` | If Slack | Slack app-level token |
| `WEBHOOK_PORT` | No | HTTP port (default: `3200`) |
| `WEBHOOK_SECRET` | No | Write API auth secret (default: `dev-secret`) |
| `OPENAI_API_KEY` | No | Embedding fallback when local embedding is unavailable |

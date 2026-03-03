# Memory System

Project-level memory that persists across conversations and tasks.

## Storage Layout

Memory now uses **SQLite as source of truth** and keeps **JSONL exports** for AI browsing compatibility.

```
data/memory/
├── index.sqlite            # Primary storage (items, vectors, FTS, embedding cache)
├── decision.jsonl          # Exported view for AI browsing
├── context.jsonl           # Exported view for AI browsing
├── preference.jsonl        # Exported view for AI browsing
├── issue.jsonl             # Exported view for AI browsing
├── task_input.jsonl        # Exported view for AI browsing
├── task_result.jsonl       # Exported view for AI browsing
└── conversations/
    ├── _state.json         # Metadata: { month → { chatId, extractedUpTo, projectPath } }
    ├── 2026-01.jsonl       # All chat messages from Jan 2026
    └── 2026-02.jsonl       # All chat messages from Feb 2026
```

### Project Registry Tables

In multi-project mode, two additional tables are added to `index.sqlite`:

- `projects` — registered git repositories (id, git_url, local_path, default_branch)
- `chat_project_map` — which chat groups are bound to which projects (chat_id, project_id, last_used)

## Why This Hybrid Design

| Concern | Current behavior |
|---------|------------------|
| Primary writes | SQLite transaction (safer and queryable) |
| Retrieval quality | Hybrid search: vector + BM25 keyword + salience |
| AI compatibility | JSONL files auto-regenerated from SQLite |
| Conversation logs | Append-only monthly JSONL files |

## Memory Namespaces

Memory items are partitioned into namespaces to prevent cross-contamination:

| Namespace | Purpose | Used by |
|-----------|---------|---------|
| `task` | Task execution memory (default) | Dispatcher, Task AI |
| `review` | PR review feedback and patterns | Review AI |

Selective cross-injection: when `ENABLE_REVIEW_CROSS_INJECT=true`, `review_pattern` memories from the `review` namespace are injected into the task dispatcher context to improve future code generation.

## Memory Types

| Type | Namespace | Source | Content |
|------|-----------|--------|---------|
| `decision` | `task` | Conversation / Task result | "Chose React over Vue because..." |
| `context` | `task` | Conversation / Task result | "Project uses monorepo with pnpm workspaces" |
| `preference` | `task` | Conversation | "User prefers early returns over nested if" |
| `issue` | `task` | Task failure / Task result | "Login page crashes on timezone edge case" |
| `task_input` | `task` | Task creation | "[Alice] Fix the timezone display bug in settings" |
| `task_result` | `task` | Task completion | "Modified 3 files, added dayjs timezone plugin" |
| `review_feedback` | `review` | PR review result | "PR #42: Found 3 issues — SQL injection in auth handler..." |
| `review_pattern` | `review` | Recurring review findings | "Repeated pattern: missing error handling in API routes" |

## Memory Item Schema

Each memory record is represented as `MemoryItem` in code (`src/memory/types.ts`), and exported to JSONL in the same shape:

```json
{"id":"mem-a1b2c3d4","type":"decision","content":"Chose dayjs over moment.js for smaller bundle size","source":"task","sourceId":"task-xyz","projectPath":"/path/to/project","createdBy":"Alice","createdAt":"2026-02-04T10:30:00.000Z"}
```

## Conversation Schema

Each line in `conversations/{YYYY-MM}.jsonl` is a `ChatMessage`:

```json
{"role":"user","content":"Fix the timezone issue on the login page","senderName":"Alice","timestamp":"2026-02-04T10:00:00.000Z"}
{"role":"assistant","content":"✅ Task created: Fix timezone display\n📋 Task ID: task-abc","timestamp":"2026-02-04T10:00:05.000Z"}
```

Metadata (`chatId`, `extractedUpTo`) is in `conversations/_state.json`, keeping the message logs append-only.

## Memory Flow

### 1. Conversation → Memory

After every `MEMORY_EXTRACT_THRESHOLD` messages (default 5), `MemoryExtractor` calls a lightweight model to extract facts:

```
Recent messages -> extractor model -> memory items -> insert into SQLite -> debounce export JSONL
```

### 2. Task → Memory

| Event | What's stored | Type |
|-------|--------------|------|
| Task created | Task description (truncated) | `task_input` |
| Task completed | Summary (thinking + modified files) | `task_result` |
| Task completed | AI-extracted decisions/issues from summary | `decision` / `issue` |
| Task failed | Error message | `issue` |

### 3. Retrieval (Hybrid Search)

Retrieval path in `MemoryStore.search()`:

1. Try embeddings (local `node-llama-cpp` model first)
2. Fall back to OpenAI embedding if `OPENAI_API_KEY` is set
3. If no embeddings available, degrade to keyword-only search
4. Merge with salience signals (`reinforcementCount`, recency)

### 4. Memory → AI Prompt

The dispatcher (Layer 1) receives two forms of memory context:

1. **Memory Index** — compact directory tree showing all categories with counts and recent previews
2. **Scored retrieved items** — top results from hybrid search

```
## Memory Storage Index
data/memory/
├── decision.jsonl (3 items)
│   └ Chose dayjs over moment.js for bundle size by Alice [2026/2/4]
│   └ API uses REST not GraphQL [2026/2/1]
├── task_result.jsonl (5 items)
│   └ Completed login module refactor, modified auth/login.ts... [2026/2/3]
│   ... 2 more
├── (empty: context.jsonl, preference.jsonl, issue.jsonl, task_input.jsonl)
└── conversations/ (3 months)
    └ 2026-02.jsonl
    └ 2026-01.jsonl
```

Layer 2 (Task AI) can still browse memory exports directly via MCP file tools (for example `read_file data/memory/decision.jsonl`).

## Key Implementation Files

| File | Responsibility |
|------|---------------|
| `src/memory/store.ts` | Memory orchestrator (SQLite, conversation logs, JSONL export) |
| `src/memory/db.ts` | SQLite schema, FTS/vector tables, data access |
| `src/memory/search.ts` | Hybrid ranking and retrieval logic |
| `src/memory/embedding.ts` | Local embedding provider + OpenAI fallback |
| `src/memory/extractor.ts` | AI-powered extraction from conversations and task outcomes |
| `src/memory/retriever.ts` | Prompt-facing memory formatting and retrieval helpers |
| `src/memory/types.ts` | `MemoryItem`, `ChatMessage`, `ConversationRecord`, `MemoryCategorySummary` |

## Adding New Memory Types

1. Add the type to `MemoryType` union in `src/memory/types.ts`
2. Add it to `MEMORY_TYPES` array in `src/memory/store.ts`
3. Ensure DB/export paths handle the new type (JSONL export auto-generates on write)
4. Set the appropriate `namespace` — review-related types should use `'review'`, all others default to `'task'`

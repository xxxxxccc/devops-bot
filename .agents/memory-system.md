# Memory System

Project-level memory that persists across conversations and tasks.

## Storage Layout

Memory now uses **SQLite as source of truth** and keeps **JSONL exports** for AI browsing compatibility.

```
data/memory/
├── index.sqlite            # Primary storage (items, vectors, FTS, embedding cache, history)
├── decision.jsonl          # Exported view for AI browsing
├── context.jsonl           # Exported view for AI browsing
├── preference.jsonl        # Exported view for AI browsing
├── issue.jsonl             # Exported view for AI browsing
├── task_input.jsonl        # Exported view for AI browsing
├── task_result.jsonl       # Exported view for AI browsing
├── {custom_type}.jsonl     # Custom types auto-exported when present
└── conversations/
    ├── _state.json         # Metadata: { month → { chatId, extractedUpTo, projectPath } }
    ├── 2026-01.jsonl       # All chat messages from Jan 2026
    └── 2026-02.jsonl       # All chat messages from Feb 2026
```

### SQLite Tables

| Table | Purpose |
|-------|---------|
| `memory_items` | Core storage (id, type, content, content_hash, source, namespace, reinforcement_count, updated_at, ...) |
| `memory_history` | Audit trail for all mutations (created/updated/deleted with old/new content) |
| `embedding_cache` | Cached embeddings keyed by content_hash (shared, reference-counted on cleanup) |
| `memory_fts` | FTS5 virtual table for BM25 keyword search |
| `memory_vec` | sqlite-vec virtual table for cosine similarity search |
| `working_memory` | Per-chat structured state (JSON) |
| `projects` | Registered git repos (multi-project mode) |
| `chat_project_map` | Chat-to-project bindings |

## Memory Namespaces

Memory items are partitioned into namespaces to prevent cross-contamination:

| Namespace | Purpose | Used by |
|-----------|---------|---------|
| `task` | Task execution memory (default) | Dispatcher, Task AI |
| `review` | PR review feedback and patterns | Review AI |

Selective cross-injection: when `ENABLE_REVIEW_CROSS_INJECT=true`, `review_pattern` memories from the `review` namespace are injected into the task dispatcher context to improve future code generation.

## Memory Types

### Built-in Types

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

### Custom Types

Projects can define custom memory types via `.devops-bot.json` (see [Per-Project Configuration](#per-project-configuration)). Custom types are automatically exported to their own JSONL files and included in the memory index.

## Memory Item Schema

Each memory record is represented as `MemoryItem` in code (`src/memory/types.ts`), and exported to JSONL in the same shape:

```json
{"id":"mem-a1b2c3d4","type":"decision","content":"Chose dayjs over moment.js for smaller bundle size","source":"task","sourceId":"task-xyz","projectPath":"/path/to/project","createdBy":"Alice","createdAt":"2026-02-04T10:30:00.000Z"}
```

## Memory Flow

### 1. Conversation → Memory

After every `MEMORY_EXTRACT_THRESHOLD` messages (default 5), `MemoryExtractor` calls a lightweight model to extract facts:

```
Recent messages -> extractor model -> memory items -> dedup pipeline -> insert into SQLite -> debounce export JSONL
```

### 2. Task → Memory

| Event | What's stored | Type |
|-------|--------------|------|
| Task created | Task description (truncated) | `task_input` |
| Task completed | Summary (thinking + modified files) | `task_result` |
| Task completed | AI-extracted decisions/issues from summary | `decision` / `issue` |
| Task failed | Error message | `issue` |

### 3. Deduplication Pipeline (on every addItem)

Two-layer dedup ensures no redundant memories:

```
New memory
  ├─ Layer 1: Hash dedup (synchronous, fast)
  │   └─ SHA-256 of normalized content → exact match? → reinforce existing
  │
  └─ Layer 2: Semantic dedup (async, LLM-powered)
      ├─ Vector search for top-5 similar memories (minScore: 0.35)
      ├─ LLM decides: ADD / UPDATE / NOOP / DELETE
      │   ├─ ADD:    genuinely new → embed and index
      │   ├─ UPDATE: refines existing → merge content, bump recency
      │   ├─ NOOP:   same meaning → reinforce existing, discard new
      │   └─ DELETE: contradicts old → remove old, keep new
      └─ Target ID validated against candidate set (prevents LLM hallucination)
```

Semantic dedup uses the same model as extraction (`MEMORY_MODEL`, default Haiku). Controlled by `MEMORY_SEMANTIC_DEDUP` env var (default: enabled).

### 4. Change Audit Trail

Every mutation (create, update, delete) writes to `memory_history`:

```sql
memory_history (memory_id, action, old_content, new_content, old_hash, new_hash, changed_at, changed_by)
```

Queryable via `db.getHistory(memoryId)`. Useful for debugging AI decisions and tracking memory evolution.

### 5. Retrieval (Hybrid Search)

Retrieval path in `MemoryStore.search()`:

1. Try embeddings (local `node-llama-cpp` model first)
2. Fall back to OpenAI embedding if `OPENAI_API_KEY` is set
3. If no embeddings available, degrade to keyword-only search
4. Merge with salience signals (`reinforcementCount`, recency)

**Salience formula:**
```
boosted = score * log(reinforcement + 1) * exp(-0.693 * daysSince / 30)
```

### 6. Memory → AI Prompt

The dispatcher (Layer 1) receives two forms of memory context:

1. **Memory Index** — compact directory tree showing all categories with counts and recent previews
2. **Scored retrieved items** — top results from hybrid search

Layer 2 (Task AI) can still browse memory exports directly via MCP file tools (e.g. `read_file data/memory/decision.jsonl`).

### 7. Periodic Pruning

Stale memories are automatically cleaned up (every 24h, first run 60s after startup):

| Strategy | Criteria | Default |
|----------|----------|---------|
| Age-based | `created_at` > N days AND `reinforcement_count` < threshold AND not recently reinforced | 90 days, < 3x reinforced |
| Count-based | Total items per project exceeds limit → prune lowest-value to 80% of limit | 1000 items max |

Pruned items are soft-deleted with full audit trail in `memory_history`. Controlled by `MEMORY_PRUNE_ENABLED` (default: enabled).

## Per-Project Configuration

Projects can customize memory extraction by placing a `.devops-bot.json` file in the project root:

```json
{
  "memory": {
    "customTypes": [
      { "name": "api_contract", "description": "API contracts and interface changes" },
      { "name": "deployment", "description": "Deployment procedures and configuration" }
    ],
    "extractTypes": ["decision", "context", "issue", "api_contract", "deployment"],
    "conversationPrompt": "Custom prompt for conversation extraction...",
    "taskResultPrompt": "Custom prompt for task result extraction..."
  }
}
```

| Field | Purpose |
|-------|---------|
| `customTypes` | Additional memory types beyond the 8 built-in ones |
| `extractTypes` | Which types to extract (filters both built-in and custom) |
| `conversationPrompt` | Override the default conversation extraction prompt |
| `taskResultPrompt` | Override the default task result extraction prompt |

Config is cached per project path. Falls back to defaults when absent.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMORY_MODEL` | `claude-haiku-4-5-20251001` | Model for extraction and semantic dedup |
| `MEMORY_EXTRACT_THRESHOLD` | `5` | Messages before conversation extraction triggers |
| `MEMORY_SEMANTIC_DEDUP` | `true` | Enable LLM-powered semantic deduplication |
| `MEMORY_SEMANTIC_DEDUP_MIN_SCORE` | `0.35` | Min similarity score for semantic dedup candidates |
| `MEMORY_SEMANTIC_DEDUP_TOP_K` | `5` | Max candidates for semantic dedup comparison |
| `MEMORY_PRUNE_ENABLED` | `true` | Enable periodic memory cleanup |
| `MEMORY_RETENTION_DAYS` | `90` | Max age for unreinforced memories |
| `MEMORY_MIN_REINFORCEMENT_KEEP` | `3` | Reinforcement count that exempts from pruning |
| `MEMORY_MAX_ITEMS_PER_PROJECT` | `1000` | Hard cap per project before count-based pruning |
| `ENABLE_REVIEW_CROSS_INJECT` | `true` | Inject review patterns into task context |
| `OPENAI_API_KEY` | — | Fallback embedding provider (text-embedding-3-small) |

## Key Implementation Files

| File | Responsibility |
|------|---------------|
| `src/memory/store.ts` | Memory orchestrator (SQLite, dedup pipeline, pruning, conversation logs, JSONL export) |
| `src/memory/db.ts` | SQLite schema, CRUD, history audit, FTS/vector tables, migrations |
| `src/memory/search.ts` | Hybrid ranking: vector + BM25 + salience boost |
| `src/memory/semantic-dedup.ts` | LLM-driven semantic deduplication (ADD/UPDATE/NOOP/DELETE decisions) |
| `src/memory/dedup.ts` | Hash-based content dedup with reinforcement counting |
| `src/memory/pruner.ts` | Periodic cleanup of stale/low-value memories |
| `src/memory/config.ts` | Per-project extraction config loader (`.devops-bot.json`) |
| `src/memory/embedding.ts` | Local embedding provider (embeddinggemma-300M) + OpenAI fallback |
| `src/memory/extractor.ts` | AI-powered extraction from conversations and task outcomes |
| `src/memory/retriever.ts` | Prompt-facing memory formatting and retrieval helpers |
| `src/memory/types.ts` | `MemoryItem`, `MemoryHistoryEntry`, `MemoryExtractionConfig`, etc. |

## Adding New Memory Types

Two approaches:

### A. Built-in (code change)

1. Add the type to `MemoryType` union in `src/memory/types.ts`
2. Add it to `MEMORY_TYPES` array in `src/memory/store.ts` and `src/memory/db.ts`
3. JSONL export and memory index automatically pick up new types

### B. Per-project (no code change)

1. Add a `.devops-bot.json` to the project root with `customTypes`
2. The extraction prompt, JSONL export, and memory index automatically include custom types
3. `MemoryItem.type` accepts `string` beyond the built-in union for flexibility

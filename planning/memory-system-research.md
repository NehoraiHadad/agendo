# Multi-Layer Persistent Memory System for AI Agents

> Research compiled 2026-03-08 for Agendo.
> Goal: Design a memory architecture that gives AI agents persistent, cross-session knowledge without flooding context windows.

---

## Table of Contents

1. [Theoretical Foundations](#1-theoretical-foundations)
2. [Existing Implementations](#2-existing-implementations)
3. [4-Layer Memory Hierarchy](#3-4-layer-memory-hierarchy)
4. [Progressive Disclosure](#4-progressive-disclosure)
5. [Background Automation](#5-background-automation)
6. [Clean Conversation Access](#6-clean-conversation-access)
7. [Agendo Integration Design](#7-agendo-integration-design)
8. [Recommended Architecture](#8-recommended-architecture)
9. [Implementation Roadmap](#9-implementation-roadmap)

---

## 1. Theoretical Foundations

### Human Memory Models

The **Atkinson-Shiffrin model** (1968) defines three memory stores:

| Store             | Duration   | Capacity  | AI Analog                               |
| ----------------- | ---------- | --------- | --------------------------------------- |
| Sensory register  | <1s        | Large     | Raw tool output, streaming tokens       |
| Short-term memory | 15-30s     | 7±2 items | Current conversation context window     |
| Long-term memory  | Indefinite | Unlimited | Persistent storage (files, DB, vectors) |

**Baddeley's working memory model** (2000) refines short-term memory into:

- **Phonological loop** — sequential processing (conversation history)
- **Visuospatial sketchpad** — spatial/structural info (codebase mental model)
- **Central executive** — attention allocation (what to retrieve)
- **Episodic buffer** — integrates across systems (cross-session context)

### Key Insights for AI Memory Design

1. **Encoding specificity** — memories are most retrievable when retrieval cues match encoding context. Implication: store memories with rich metadata (task, project, agent, timestamp).
2. **Spacing effect** — repeated exposure strengthens memory. Implication: frequently-accessed memories should be promoted.
3. **Interference** — similar memories compete. Implication: deduplication and consolidation are critical.
4. **Levels of processing** — deep semantic processing creates stronger memories than shallow encoding. Implication: summarized/interpreted memories > raw logs.

---

## 2. Existing Implementations

### 2.1 Claude Code — CLAUDE.md + Auto-Memory

**Architecture**: File-based, hierarchical.

```
~/.claude/
├── CLAUDE.md                          # Global instructions (always loaded)
├── projects/<path-encoded>/
│   ├── MEMORY.md                      # Project auto-memory (always loaded, 200-line cap)
│   └── memory/
│       ├── debugging.md               # Topic files (loaded on demand)
│       └── patterns.md
└── <project>/
    └── CLAUDE.md                      # Repo-level instructions (checked in)
```

**How it works**:

- `CLAUDE.md` files are always injected into the system prompt (zero retrieval cost)
- `MEMORY.md` auto-memory is appended to context at conversation start (200-line cap)
- Topic files in `memory/` must be explicitly read via `Read` or `Grep` tools
- Agent decides what to save based on heuristics (corrections, repeated patterns, user requests)
- No semantic search — relies on file organization and grep

**Strengths**: Zero latency, no external dependencies, human-readable, version-controllable.
**Weaknesses**: 200-line cap is tiny, no automatic retrieval of topic files, no semantic search, no cross-project memory, manual organization burden.

### 2.2 OpenAI Codex — Memory Tool

**Architecture**: File-based, single-layer.

```
~/.codex/
├── instructions.md       # Global instructions (like CLAUDE.md)
└── memory/
    └── <key>.md          # Named memory entries
```

**How it works**:

- `memory_tool` feature flag enables `memory/read` and `memory/write` operations
- Memories stored as named markdown files
- Instructions.md always loaded (like CLAUDE.md)
- Memory entries are key-value — agent picks a key name when storing

**Strengths**: Simple, predictable key-value model.
**Weaknesses**: No semantic retrieval, no automatic consolidation, flat namespace.

### 2.3 Google Gemini — Memory System

**Architecture**: Server-side, user-scoped.

**How it works**:

- Gemini stores "memories" server-side (Google's infrastructure)
- Memories are facts extracted from conversations
- Automatically surfaced in future conversations based on relevance
- User can view/delete memories in settings
- CLI (`gemini-cli`) does not expose memory APIs — memory is a Gemini web/API feature

**Strengths**: Automatic extraction, semantic retrieval, zero user effort.
**Weaknesses**: Opaque (user can't see retrieval logic), cloud-only, not available in CLI mode, no structured hierarchy.

### 2.4 Mem0

**Architecture**: Hybrid datastore (vector + graph + key-value), cloud or self-hosted.

```
┌─────────────────────────────────┐
│  Mem0 Platform                  │
│  ┌──────────┐ ┌──────────────┐  │
│  │  Vector   │ │  Graph       │  │
│  │  Store    │ │  Store       │  │
│  │ (semantic)│ │ (relations)  │  │
│  └──────────┘ └──────────────┘  │
│  ┌──────────┐                   │
│  │  Key-Val  │                  │
│  │  Store    │                  │
│  │ (facts)   │                  │
│  └──────────┘                   │
└─────────────────────────────────┘
```

**Memory scopes**: User, Session, Agent (hierarchical).

**Core pipeline**:

1. **Extract** — LLM-powered fact extraction from conversations
2. **Deduplicate** — resolve conflicts with existing memories
3. **Store** — atomic facts in vector store, relationships in graph store
4. **Retrieve** — semantic search + graph traversal at query time

**Key innovation**: Graph memory captures relationships between entities (people → projects → preferences → decisions). This enables multi-hop retrieval: "What did the user decide about auth?" → finds auth decision → linked to project → linked to tech choices.

**Performance**: 26% accuracy improvement over full-context baselines, 91% lower p95 latency, 90%+ token savings (avoiding full conversation replay).

**Strengths**: Production-grade, semantic + relational retrieval, automatic extraction.
**Weaknesses**: External dependency, requires embedding model, adds latency to every interaction.

### 2.5 Zep

**Architecture**: Knowledge graph + temporal awareness.

**Key differentiator**: Temporal knowledge graphs — memories have timestamps and Zep understands how facts change over time ("User used React in 2024, switched to Vue in 2025").

**Features**:

- Automatic entity extraction and relationship mapping
- Fact versioning (superseded facts tracked)
- Dialog classification (what type of conversation is this?)
- Session-scoped and user-scoped memory
- Built-in summarization of old conversations

**Strengths**: Temporal awareness, fact versioning, structured knowledge.
**Weaknesses**: Heavy infrastructure (requires separate Zep server), focused on chat applications.

### 2.6 Letta (formerly MemGPT)

**Architecture**: OS-inspired memory hierarchy with explicit memory management.

```
┌─────────────────────────────────────┐
│  Main Context (limited)             │
│  ┌─────────┐ ┌───────────────────┐  │
│  │ System  │ │ Working Memory    │  │
│  │ Prompt  │ │ (editable block)  │  │
│  └─────────┘ └───────────────────┘  │
│  ┌─────────────────────────────────┐│
│  │ Conversation Buffer (FIFO)     ││
│  └─────────────────────────────────┘│
└──────────────┬──────────────────────┘
               │ overflow
┌──────────────▼──────────────────────┐
│  Archival Memory (unbounded)        │
│  - Vector-indexed passages          │
│  - Search via embedding similarity  │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│  Recall Memory (conversation logs)  │
│  - Full conversation history        │
│  - Keyword + date search            │
└─────────────────────────────────────┘
```

**Key innovations**:

1. **Self-editing memory** — the agent explicitly decides what to move between tiers using tools (`core_memory_append`, `core_memory_replace`, `archival_memory_insert`, `archival_memory_search`)
2. **Inner monologue** — agent "thinks" before each response, including memory management reasoning
3. **Heartbeat** — agent can request to continue processing (not limited to single response)
4. **Conversation overflow** — old messages automatically move to recall memory

**Strengths**: Agent has full control, mirrors OS virtual memory, theoretically unlimited context.
**Weaknesses**: High overhead (every turn includes memory management), agent must learn to use memory well, complex to implement.

### 2.7 LangChain Memory

**Types** (from simplest to most complex):

| Type                              | Mechanism                        | Token Cost             |
| --------------------------------- | -------------------------------- | ---------------------- |
| `ConversationBufferMemory`        | Store all messages               | O(n) — grows unbounded |
| `ConversationBufferWindowMemory`  | Last k messages                  | O(k) — fixed window    |
| `ConversationSummaryMemory`       | LLM summarizes history           | O(1) — fixed size      |
| `ConversationSummaryBufferMemory` | Recent messages + summary of old | O(k) — best of both    |
| `ConversationEntityMemory`        | Extract entities + attributes    | O(entities)            |
| `VectorStoreRetrieverMemory`      | Embed + retrieve by similarity   | O(k) — top-k results   |

**Key insight**: LangChain treats these as composable primitives. Real systems combine multiple types (e.g., entity memory + summary + vector retrieval).

### 2.8 Comparison Matrix

| System           | Storage         | Retrieval             | Automatic?         | Multi-agent?     | Self-hosted? |
| ---------------- | --------------- | --------------------- | ------------------ | ---------------- | ------------ |
| Claude CLAUDE.md | Files           | Always-loaded + grep  | Semi (auto-memory) | No               | Yes          |
| Codex memory     | Files           | Key-value lookup      | No                 | No               | Yes          |
| Gemini           | Cloud           | Semantic (opaque)     | Yes                | No               | No           |
| Mem0             | Vector+Graph+KV | Semantic + graph      | Yes                | Yes (scopes)     | Yes          |
| Zep              | Knowledge graph | Temporal + semantic   | Yes                | Yes              | Yes          |
| Letta/MemGPT     | Vector + recall | Agent-directed search | Agent-managed      | Yes              | Yes          |
| LangChain        | Configurable    | Configurable          | Configurable       | Via shared store | Yes          |

---

## 3. 4-Layer Memory Hierarchy

Based on the research above, here is a synthesized 4-layer hierarchy optimized for AI coding agents:

### Layer 0: Working Memory (Conversation Context)

**What**: The current conversation's messages, tool results, and in-flight state.
**Duration**: Single conversation turn / session.
**Capacity**: Model's context window (typ. 100k-200k tokens).
**Management**: Automatic (conversation history + context compression).

```
┌─────────────────────────────────────────┐
│  Working Memory                          │
│  - System prompt + CLAUDE.md/instructions│
│  - Conversation messages                 │
│  - Tool call results                     │
│  - Active task context (from Agendo)     │
│  - Retrieved memories (from lower layers)│
└─────────────────────────────────────────┘
```

**Key design decisions**:

- Always-loaded context (CLAUDE.md, task description) is part of working memory
- Retrieved memories injected here at conversation start or on-demand
- Context compression handles overflow (Claude's automatic compression)
- No explicit management needed — this is the model's native mode

### Layer 1: Short-Term Memory (Session State)

**What**: Facts, decisions, and context from the current task/session that should persist across conversation restarts but aren't yet validated as long-term knowledge.
**Duration**: Hours to days (task lifetime).
**Capacity**: ~50-100 atomic facts per session.
**Storage**: Database (Agendo's `progress_notes` + new `session_memories` table).

```
┌─────────────────────────────────────────┐
│  Short-Term Memory                       │
│  - Progress notes on current task        │
│  - Decisions made during this session    │
│  - Errors encountered and fixes applied  │
│  - Key file paths discovered             │
│  - Conversation summaries                │
└─────────────────────────────────────────┘
```

**Key design decisions**:

- Agent explicitly writes STM entries via MCP tools (`save_memory`, `recall_memories`)
- Automatically loaded when resuming a session or starting a new session on the same task
- Shared across agents working on the same task (multi-agent collaboration)
- Expires/archives when task is completed
- Progress notes are already a primitive form of STM in Agendo

### Layer 2: Long-Term Memory (Project Knowledge)

**What**: Validated patterns, architectural decisions, debugging solutions, and user preferences scoped to a project.
**Duration**: Weeks to months (project lifetime).
**Capacity**: Hundreds of entries per project.
**Storage**: Database with vector embeddings for semantic retrieval.

```
┌─────────────────────────────────────────┐
│  Long-Term Memory                        │
│  - Architectural decisions               │
│  - Debugging patterns (error → fix)      │
│  - Code conventions and style rules      │
│  - User preferences per project          │
│  - Dependency/API quirks                 │
│  - Performance bottleneck solutions      │
└─────────────────────────────────────────┘
```

**Key design decisions**:

- Populated by: (a) promotion from STM, (b) direct agent writes, (c) background consolidation
- Retrieved via semantic search at session start (top-k most relevant to task description)
- Scoped to project (projectId foreign key)
- Supports importance scoring and access-count tracking
- Human-reviewable and editable (transparency)

### Layer 3: Archival Memory (Cross-Project Knowledge)

**What**: Universal patterns, general debugging knowledge, cross-project insights, and workspace-level preferences.
**Duration**: Months to years (workspace lifetime).
**Capacity**: Thousands of entries.
**Storage**: Database with vector embeddings, optionally backed by knowledge graph.

```
┌─────────────────────────────────────────┐
│  Archival Memory                         │
│  - Cross-project patterns               │
│  - General debugging heuristics          │
│  - Technology-specific knowledge         │
│  - User global preferences              │
│  - Team conventions                      │
│  - Historical decision rationale         │
└─────────────────────────────────────────┘
```

**Key design decisions**:

- Populated by: promotion from LTM when patterns repeat across projects
- Retrieved via semantic search, but with higher relevance threshold (avoid noise)
- Scoped to workspace (workspaceId)
- Knowledge graph relationships optional but valuable for multi-hop queries
- Least frequently accessed — only retrieved when explicitly relevant

### Layer Interaction Flow

```
                    ┌──────────────┐
   User message ───►│   Working    │ ◄─── Retrieved memories
                    │   Memory     │       (injected at start)
                    └──────┬───────┘
                           │ Agent writes via MCP
                    ┌──────▼───────┐
                    │  Short-Term  │ ◄─── Task progress, session state
                    │   Memory     │
                    └──────┬───────┘
                           │ Promotion (task complete / pattern detected)
                    ┌──────▼───────┐
                    │  Long-Term   │ ◄─── Project knowledge
                    │   Memory     │
                    └──────┬───────┘
                           │ Promotion (cross-project pattern)
                    ┌──────▼───────┐
                    │   Archival   │ ◄─── Universal knowledge
                    │   Memory     │
                    └──────────────┘
```

---

## 4. Progressive Disclosure

The critical challenge: **how to surface relevant memories without consuming excessive context tokens**.

### Strategy 1: Layered Injection

Load memories in stages, not all at once:

1. **Always loaded** (Layer 0): CLAUDE.md, task description, project config — ~2-5k tokens
2. **Session start** (Layer 1): STM for current task — ~1-3k tokens (summarized)
3. **Semantic retrieval** (Layers 2-3): Top-k relevant LTM/archival entries — ~1-2k tokens
4. **On-demand** (all layers): Agent queries memory when it needs more context

Total automatic injection: **~5-10k tokens** (vs. 100k+ context window = 5-10% overhead).

### Strategy 2: Memory Summaries

Don't inject full memories — inject summaries with retrieval handles:

```
## Relevant Memories (8 entries)
- [M-142] Auth uses JWT with 24h expiry, refresh tokens in httpOnly cookies
- [M-089] PostgreSQL NOTIFY has 8000-byte payload limit — use ref stubs for large payloads
- [M-203] User prefers explicit error handling over try-catch wrapping
- [M-167] The deploy script requires AWS_PROFILE=production

Use `recall_memory(id)` to get full details on any entry.
```

This gives the agent awareness of what it knows without consuming tokens on details it may not need.

### Strategy 3: Relevance Scoring

Score memories before injection using:

- **Semantic similarity** to current task description (embedding cosine distance)
- **Recency** — recent memories weighted higher (exponential decay)
- **Access frequency** — frequently-retrieved memories are likely important
- **Importance** — agent-assigned importance score (1-5)
- **Scope match** — task-scoped > project-scoped > workspace-scoped

Formula (example):

```
relevance = 0.4 * semantic_similarity
           + 0.2 * recency_score
           + 0.15 * access_frequency_normalized
           + 0.15 * importance_normalized
           + 0.1 * scope_match_bonus
```

### Strategy 4: Contextual Triggers

Some memories should only surface in specific contexts:

- **Error memories**: surface when similar error messages appear in tool output
- **File memories**: surface when the agent reads/edits files mentioned in the memory
- **Dependency memories**: surface when working with specific packages/APIs
- **Pattern memories**: surface when the agent is about to repeat a known mistake

Implementation: lightweight pattern matching on conversation content, triggering targeted memory retrieval mid-conversation (not just at start).

---

## 5. Background Automation

### 5.1 Automatic Fact Extraction

After each session ends, a background job processes the conversation:

```
Session ends
  → pg-boss job: `consolidate-session-memory`
  → LLM extracts atomic facts from conversation transcript
  → Deduplicates against existing STM/LTM entries
  → Stores new facts as STM entries linked to task
```

**Extraction prompt** (simplified):

```
Given this conversation transcript, extract atomic facts that would be useful
in future sessions. Focus on:
- Decisions made and their rationale
- Bugs found and their fixes
- Code patterns discovered
- User corrections or preferences expressed
- Architectural insights

Output as JSON array of {fact, importance: 1-5, tags: string[]}.
Ignore transient information (file contents, build output, etc.).
```

### 5.2 Memory Consolidation (STM → LTM Promotion)

When a task completes, promote relevant STM to LTM:

```
Task marked done
  → pg-boss job: `promote-task-memories`
  → Review all STM entries for this task
  → LLM evaluates: "Is this fact useful beyond this specific task?"
  → If yes → create LTM entry with project scope
  → If similar LTM entry exists → merge/update (not duplicate)
  → Archive original STM entries (don't delete — audit trail)
```

### 5.3 Cross-Project Pattern Detection (LTM → Archival)

Periodic background job scans for repeated patterns:

```
Cron: weekly
  → pg-boss job: `detect-cross-project-patterns`
  → Find LTM entries with high semantic similarity across different projects
  → LLM evaluates: "Is this a general pattern or project-specific?"
  → If general → create archival entry with workspace scope
  → Tag with relevant technologies/domains
```

### 5.4 Memory Decay

Not all memories stay relevant forever:

- **Access tracking**: each retrieval updates `lastAccessedAt` and increments `accessCount`
- **Decay formula**: `effective_importance = importance * decay_factor(age, lastAccessed)`
- **Cleanup job**: monthly, archive memories below threshold
- **Never auto-delete**: move to archival with `archived: true` flag — human can restore

### 5.5 Conflict Resolution

When new facts contradict existing memories:

1. **Timestamp wins** — newer fact supersedes older (but old fact kept with `supersededBy` link)
2. **Agent can override** — explicit `update_memory(id, newContent)` replaces
3. **User corrections always win** — memories from user corrections get `source: 'user_correction'` and highest importance

---

## 6. Clean Conversation Access

### 6.1 MCP Tool Interface

Memory access happens through MCP tools — same pattern agents already use for task management:

```typescript
// Write operations
save_memory(content, tags?, importance?, scope?)     // Store a new memory
update_memory(id, content)                           // Update existing memory
forget_memory(id)                                    // Soft-delete a memory

// Read operations
recall_memories(query, scope?, limit?)               // Semantic search
get_memory(id)                                       // Get full memory by ID
list_recent_memories(scope?, limit?)                 // Recent memories

// Bulk operations
search_memories(query, filters?)                     // Advanced search with filters
```

**Why MCP tools?**

- Agents already know MCP — no new protocol to learn
- Works across all agent types (Claude, Codex, Gemini)
- Doesn't pollute conversation with retrieval infrastructure
- Tool results are structured and predictable
- Can be rate-limited and access-controlled

### 6.2 Automatic Injection (No Tool Call Needed)

Some memories should be available without the agent asking:

1. **Session preamble** — when session starts, inject a `## Relevant Memories` section in the system context (after task description, before conversation begins)
2. **Content**: top-k memories ranked by relevance to task description
3. **Format**: summary with IDs for drill-down
4. **Budget**: max 2000 tokens for auto-injected memories

This happens in `session-runner.ts` during preamble construction — the same place task context and MCP instructions are already injected.

### 6.3 Mid-Conversation Retrieval

For contextual triggers (error patterns, file references):

Option A: **System message injection** — insert a system message with relevant memories when triggers fire. Problem: some agents don't handle mid-conversation system messages well.

Option B: **Tool suggestion** — when a trigger fires, append a hint to the next tool result: `"Tip: relevant memory M-142 exists about this error. Use recall_memories() if needed."` Less intrusive.

Option C: **Background enrichment** — the MCP server intercepts certain tool calls (e.g., `get_my_task`) and appends relevant memories to the response. Zero extra tool calls needed.

**Recommended**: Start with Option B (minimal, non-intrusive), upgrade to Option C when the system proves valuable.

---

## 7. Agendo Integration Design

### 7.1 Existing Primitives to Build On

Agendo already has several memory-adjacent primitives:

| Primitive           | Current Purpose               | Memory Analog                      |
| ------------------- | ----------------------------- | ---------------------------------- |
| `progress_notes`    | Task progress tracking        | Short-term memory (task-scoped)    |
| `CLAUDE.md`         | Project instructions          | Long-term memory (always-loaded)   |
| Task `description`  | Task context                  | Working memory injection           |
| Task `inputContext` | Structured task params        | Working memory injection           |
| Session preamble    | Agent startup context         | Memory injection point             |
| MCP tools           | Agent ↔ Agendo communication  | Memory access channel              |
| `plan_versions`     | Plan snapshots                | Episodic memory (decision history) |
| Session logs        | Full conversation transcripts | Raw memory source for extraction   |

### 7.2 Proposed Data Model

```sql
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  project_id    UUID REFERENCES projects(id),      -- NULL = workspace-scoped
  task_id       UUID REFERENCES tasks(id),          -- NULL = not task-scoped
  session_id    UUID REFERENCES sessions(id),       -- source session (nullable)

  -- Content
  content       TEXT NOT NULL,                       -- the memory itself
  summary       TEXT,                                -- short version for injection
  tags          TEXT[] DEFAULT '{}',                  -- for filtering

  -- Metadata
  layer         TEXT NOT NULL CHECK (layer IN ('stm', 'ltm', 'archival')),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source        TEXT NOT NULL DEFAULT 'agent',       -- 'agent', 'user', 'system', 'consolidation'

  -- Retrieval tracking
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,

  -- Embedding (for semantic search)
  embedding     vector(1536),                        -- pgvector, model-dependent dimension

  -- Lifecycle
  superseded_by UUID REFERENCES memories(id),        -- for fact versioning
  archived      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_memories_project ON memories(project_id) WHERE NOT archived;
CREATE INDEX idx_memories_task ON memories(task_id) WHERE NOT archived;
CREATE INDEX idx_memories_layer ON memories(layer) WHERE NOT archived;
CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops);
```

### 7.3 Integration Points

```
Session Start (session-runner.ts)
  │
  ├─ Build preamble (existing)
  │   ├─ Task description ✓
  │   ├─ MCP tool instructions ✓
  │   └─ ★ Inject relevant memories (NEW)
  │       ├─ STM: all memories for this task
  │       ├─ LTM: top-5 by relevance to task description
  │       └─ Archival: top-3 by relevance (if no LTM matches)
  │
  └─ Register MCP tools (existing)
      ├─ get_my_task, update_task, etc. ✓
      └─ ★ save_memory, recall_memories (NEW)

Session Active
  │
  └─ Agent uses MCP tools as needed
      ├─ save_memory → writes to memories table
      └─ recall_memories → semantic search → returns results

Session End
  │
  └─ ★ pg-boss job: consolidate-session-memory (NEW)
      ├─ Extract facts from session log
      ├─ Deduplicate against existing
      └─ Store as STM entries

Task Complete
  │
  └─ ★ pg-boss job: promote-task-memories (NEW)
      ├─ Review STM entries
      ├─ Promote valuable ones to LTM
      └─ Archive task-specific STM
```

### 7.4 MCP Tool Additions

Add to `src/lib/mcp/server.ts`:

```typescript
// New MCP tools for memory management
save_memory: {
  params: { content: string, tags?: string[], importance?: number, scope?: 'task' | 'project' | 'workspace' },
  // Stores a memory entry. Scope determines layer:
  // 'task' → STM, 'project' → LTM, 'workspace' → archival
}

recall_memories: {
  params: { query: string, scope?: 'task' | 'project' | 'workspace' | 'all', limit?: number },
  // Semantic search across memories. Returns summaries with IDs.
}

get_memory: {
  params: { id: string },
  // Get full memory content by ID (for drill-down from summaries).
}

update_memory: {
  params: { id: string, content: string },
  // Update an existing memory. Creates supersedure link.
}
```

### 7.5 Embedding Strategy

**Options**:

| Approach                                | Pros                       | Cons                          |
| --------------------------------------- | -------------------------- | ----------------------------- |
| OpenAI `text-embedding-3-small`         | Good quality, 1536-dim     | External API, cost            |
| Local model (e.g., `nomic-embed-text`)  | No API dependency, fast    | Requires GPU or CPU inference |
| PostgreSQL `pg_trgm` + full-text search | Zero dependencies          | No semantic understanding     |
| Hybrid: full-text + trigram scoring     | Good enough for code, fast | Misses semantic similarity    |

**Recommended**: Start with **PostgreSQL full-text search + trigram similarity** (zero new dependencies). Add vector embeddings as a later enhancement when the system proves valuable. Agendo already uses PostgreSQL — adding `pg_trgm` is trivial.

```sql
-- Full-text search (built into PostgreSQL)
ALTER TABLE memories ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content || ' ' || coalesce(array_to_string(tags, ' '), ''))) STORED;
CREATE INDEX idx_memories_search ON memories USING gin(search_vector);

-- Trigram similarity (for fuzzy matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_memories_trgm ON memories USING gin(content gin_trgm_ops);
```

---

## 8. Recommended Architecture

### Phase 1: Foundation (Minimal Viable Memory)

**Goal**: Give agents the ability to explicitly store and retrieve memories, with automatic injection at session start.

1. **`memories` table** with `content`, `tags`, `layer`, `importance`, `project_id`, `task_id`
2. **Two MCP tools**: `save_memory`, `recall_memories` (full-text search, no embeddings)
3. **Preamble injection**: top-5 memories by recency + importance, injected in session-runner.ts
4. **Preamble hint**: tell agents about memory tools in their startup instructions

**Complexity**: Low. ~1 migration, ~1 service file, ~2 MCP tools, ~20 lines in session-runner.ts.
**Value**: Agents can persist knowledge across sessions immediately.

### Phase 2: Automation

**Goal**: Reduce manual memory burden — automatically extract and consolidate.

1. **Post-session extraction** job (pg-boss)
2. **Task completion promotion** (STM → LTM)
3. **Memory deduplication** (detect near-duplicates)
4. **Access tracking** (count retrievals, update `lastAccessedAt`)

**Complexity**: Medium. Requires LLM calls in background jobs (cost consideration).

### Phase 3: Intelligence

**Goal**: Semantic retrieval and contextual triggering.

1. **Vector embeddings** (pgvector extension + embedding API)
2. **Semantic search** in `recall_memories`
3. **Contextual triggers** (error pattern matching → auto-retrieve relevant memories)
4. **Cross-project pattern detection** (background consolidation)
5. **Memory UI** — web interface for viewing, editing, and managing memories

**Complexity**: High. Requires embedding infrastructure, pgvector, trigger system.

### Phase 4: Knowledge Graph (Optional)

**Goal**: Relationship-aware memory for multi-hop queries.

1. **Entity extraction** (people, projects, technologies, decisions)
2. **Relationship edges** (decided → technology, blocked-by → issue, prefers → pattern)
3. **Graph traversal queries** ("What decisions were made about auth in this project?")
4. **Temporal versioning** (how did this decision evolve?)

**Complexity**: Very high. Consider only if Phases 1-3 prove insufficient.

---

## 9. Implementation Roadmap

### Immediate (Phase 1 — can start now)

```
1. Create memories table migration
2. Create memory-service.ts (CRUD + full-text search)
3. Add save_memory + recall_memories MCP tools
4. Update session-runner.ts preamble to inject memories
5. Update agent preamble instructions to mention memory tools
```

**Estimated scope**: ~5 files, ~300 lines of new code.

### Short-term (Phase 2 — after Phase 1 proves useful)

```
1. Add consolidate-session-memory pg-boss job
2. Add promote-task-memories pg-boss job
3. Implement access tracking in recall_memories
4. Add memory dedup logic
```

### Medium-term (Phase 3 — when retrieval quality matters)

```
1. Add pgvector extension
2. Implement embedding pipeline (on save + batch backfill)
3. Switch recall_memories to vector similarity search
4. Add contextual trigger system
5. Build memory management UI
```

---

## Appendix A: Token Budget Analysis

For a typical Agendo session with 200k context window:

| Component                   | Tokens     | % of Context |
| --------------------------- | ---------- | ------------ |
| System prompt + CLAUDE.md   | ~3,000     | 1.5%         |
| Task description + preamble | ~2,000     | 1.0%         |
| MCP tool definitions        | ~1,500     | 0.75%        |
| **Auto-injected memories**  | **~2,000** | **1.0%**     |
| Available for conversation  | ~191,500   | 95.75%       |

Memory injection at **1% of context** is negligible overhead for significant value.

## Appendix B: Memory Entry Examples

```json
{
  "layer": "stm",
  "content": "The session WebSocket connection drops after 60s idle. Fixed by adding ping/pong heartbeat at 30s interval in terminal-server.ts.",
  "tags": ["websocket", "terminal", "debugging"],
  "importance": 4,
  "source": "agent",
  "task_id": "abc-123"
}
```

```json
{
  "layer": "ltm",
  "content": "pg-boss v10 removed teamSize option. To get N concurrent workers, call boss.work() N times instead of teamSize:N.",
  "tags": ["pg-boss", "worker", "migration"],
  "importance": 5,
  "source": "consolidation",
  "project_id": "26d1d2e3-..."
}
```

```json
{
  "layer": "archival",
  "content": "User prefers explicit error handling with early returns over try-catch wrapping. Avoid adding error handling for scenarios that can't happen.",
  "tags": ["preferences", "code-style"],
  "importance": 4,
  "source": "user_correction"
}
```

## Appendix C: Notable Emerging Systems (2025-2026)

### MemOS (July 2025, Shanghai Jiao Tong University)

A full "memory operating system" with three-layer architecture (Interface / Operation / Infrastructure). Introduces **MemCube** as a unified memory abstraction with provenance and versioning. Claims 159% boost in temporal reasoning vs OpenAI, 38.9% LOCOMO improvement. (arxiv.org/abs/2507.03724)

### A-MEM (NeurIPS 2025)

Self-organizing agentic memory using Zettelkasten principles. The agent manages memory organization through dynamic indexing and linking — memories evolve rather than just accumulate. New memories trigger updates to existing memories' representations. Doubles performance on multi-hop reasoning tasks. (arxiv.org/abs/2502.12110)

### Amazon Bedrock AgentCore Memory

Managed service with built-in strategies (summarization, semantic memory, user preferences). Key insight: long-term memory generation runs **asynchronously** after raw conversation is stored in short-term memory — "sleep-time computation" pattern.

### Google Always On Memory Agent (March 2026)

Open-sourced by Google PM. Ingests information continuously and consolidates in background **without a vector database**. Built with Gemini 3.1 Flash-Lite. Demonstrates that simpler architectures can work for continuous memory.

### Zep/Graphiti Deep Architecture

Zep's core is **Graphiti**, a temporally-aware knowledge graph engine with three hierarchical subgraph tiers: **Episode** (raw episodic data), **Semantic entity** (extracted entities/relationships), **Community** (high-level domain summaries). Uses a **bi-temporal data model** tracking both event-occurrence and ingestion times. 94.8% accuracy on Deep Memory Retrieval (vs MemGPT's 93.4%). (arxiv.org/abs/2501.13956)

### Memory-as-a-Service (MaaS)

Emerging pattern: decouples memory from agents into independently callable, composable service modules with permission-aware governance. Enables multi-agent shared memory with asymmetric access controls. (arxiv.org/html/2506.22815v1)

## Appendix D: Key References

- Atkinson & Shiffrin (1968) — Multi-store model of memory
- Baddeley (2000) — Working memory model
- Park et al. (2023) — "Generative Agents" (Stanford), introduced recency/importance/relevance scoring
- Packer et al. (2023) — arxiv.org/abs/2310.08560, "MemGPT: Towards LLMs as Operating Systems"
- Mem0 (2025) — arxiv.org/abs/2504.19413, "Building Production-Ready AI Agents with Scalable Long-Term Memory"
- Zep/Graphiti (2025) — arxiv.org/abs/2501.13956, temporal knowledge graph architecture
- A-MEM (2025) — arxiv.org/abs/2502.12110, self-organizing agentic memory
- MemOS (2025) — arxiv.org/abs/2507.03724, memory operating system
- HiAgent (ACL 2025) — aclanthology.org/2025.acl-long.1575, hierarchical working memory management
- Memory in the Age of AI Agents (2025) — arxiv.org/abs/2512.13564, comprehensive survey
- LangChain Memory — docs.langchain.com/docs/modules/memory
- Claude Code auto-memory — docs.anthropic.com/en/docs/claude-code
- Letta Code — letta.com/blog/letta-code, memory-first coding agent

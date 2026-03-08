# Plugin Architecture for Agendo

> Design document for Agendo's extensibility framework.
> Status: **Draft** | Author: Claude | Date: 2026-03-08

## 1. Overview

Agendo needs an extensibility framework that allows external functionality to be integrated as **plugins** — self-contained units that extend the platform without modifying core code. The first plugin is **repo-sync** (synchronizing external repos), but the framework must support diverse use cases: custom agent adapters, MCP tool providers, webhook integrations, scheduled jobs, and UI extensions.

### Design Goals

1. **Simple plugin contract** — a plugin is a TypeScript module exporting a manifest + lifecycle hooks
2. **Safe isolation** — a crashing plugin cannot take down the host worker or Next.js app
3. **Discoverable** — plugins are listed in the settings UI with enable/disable toggles
4. **Configurable** — plugins declare a JSON Schema for their settings; the UI renders a form
5. **Composable** — plugins can register multiple extension points (hooks, MCP tools, worker jobs)
6. **Zero-config for built-in plugins** — ship with the app, enabled by default

### Non-Goals (v1)

- Plugin marketplace / remote installation
- Multi-tenant plugin isolation (single-workspace for now)
- Frontend component plugins (UI extensions beyond settings)
- Plugin-to-plugin dependencies

---

## 2. Plugin Interface

### 2.1 Plugin Manifest

Every plugin exports a `PluginManifest` describing itself:

```typescript
interface PluginManifest {
  /** Unique identifier (kebab-case). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description shown in settings UI. */
  description: string;
  /** SemVer version string. */
  version: string;
  /** Minimum Agendo version required. */
  minAgendoVersion?: string;
  /** Icon name (lucide icon) for the settings UI. */
  icon?: string;
  /** Plugin category for grouping in UI. */
  category?: 'integration' | 'automation' | 'agent' | 'utility';
  /** JSON Schema for plugin-specific configuration. */
  configSchema?: JSONSchema7;
  /** Default configuration values. */
  defaultConfig?: Record<string, unknown>;
}
```

### 2.2 Plugin Lifecycle

```typescript
interface AgendoPlugin {
  manifest: PluginManifest;

  /**
   * Called once when the plugin is loaded (app startup or first enable).
   * Use for one-time setup: register event listeners, schedule jobs, etc.
   * Receives the PluginContext with scoped services.
   */
  activate(ctx: PluginContext): Promise<void>;

  /**
   * Called when the plugin is disabled or the app shuts down.
   * Clean up resources: unsubscribe listeners, cancel timers, etc.
   */
  deactivate?(): Promise<void>;

  /**
   * Called when plugin configuration changes at runtime.
   * Plugins should re-read their config and adjust behavior.
   */
  onConfigChange?(config: Record<string, unknown>): Promise<void>;
}
```

### 2.3 Plugin Context

The host provides a scoped `PluginContext` to each plugin — the plugin's only interface to Agendo:

```typescript
interface PluginContext {
  /** Plugin's own configuration (typed by the plugin). */
  config: Record<string, unknown>;

  /** Scoped logger (prefixed with plugin ID). */
  logger: PluginLogger;

  /** Register lifecycle hooks on Agendo events. */
  hooks: HookRegistry;

  /** Register pg-boss worker jobs. */
  jobs: JobRegistry;

  /** Register MCP tools available to agents. */
  mcpTools: McpToolRegistry;

  /** Access core Agendo services (read-only for most). */
  services: {
    tasks: Pick<TaskService, 'getTask' | 'listTasks' | 'updateTask' | 'createTask'>;
    projects: Pick<ProjectService, 'getProject' | 'listProjects'>;
    agents: Pick<AgentService, 'getAgent' | 'listAgents'>;
    sessions: Pick<SessionService, 'getSession' | 'listSessions'>;
  };

  /** Key-value storage scoped to this plugin. */
  store: PluginStore;
}
```

---

## 3. Extension Points

### 3.1 Lifecycle Hooks

Plugins can subscribe to system events:

```typescript
interface HookRegistry {
  on(event: 'task:created', handler: (task: Task) => Promise<void>): void;
  on(event: 'task:updated', handler: (task: Task, changes: Partial<Task>) => Promise<void>): void;
  on(event: 'task:completed', handler: (task: Task) => Promise<void>): void;
  on(event: 'session:started', handler: (session: Session) => Promise<void>): void;
  on(event: 'session:ended', handler: (session: Session) => Promise<void>): void;
  on(event: 'project:created', handler: (project: Project) => Promise<void>): void;
}
```

Hooks are fire-and-forget — they cannot block the core operation. Errors are logged but don't propagate.

### 3.2 Worker Jobs

Plugins can register custom pg-boss job types:

```typescript
interface JobRegistry {
  /** Register a new job type with a handler. */
  register(jobName: string, handler: JobHandler, options?: JobOptions): void;
  /** Enqueue a job for later processing. */
  enqueue(jobName: string, data: unknown, options?: EnqueueOptions): Promise<string>;
}

interface JobOptions {
  /** Cron schedule (e.g., '*/5 * * * *' for every 5 minutes). */
  cron?: string;
  /** Retry policy. */
  retryLimit?: number;
  retryDelay?: number;
  /** Job timeout in seconds. */
  expireInSeconds?: number;
}
```

### 3.3 MCP Tools

Plugins can expose tools to AI agents via MCP:

```typescript
interface McpToolRegistry {
  register(tool: McpToolDefinition): void;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  handler: (input: Record<string, unknown>, context: McpToolContext) => Promise<unknown>;
}
```

### 3.4 Plugin Store

Scoped key-value storage backed by a database table:

```typescript
interface PluginStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}
```

---

## 4. Discovery & Registration

### 4.1 Built-in Plugins

Ship with Agendo in `src/lib/plugins/builtin/`:

```
src/lib/plugins/
├── types.ts              # Plugin interfaces
├── plugin-registry.ts    # Central registry (singleton)
├── plugin-loader.ts      # Discovery + loading logic
├── plugin-context.ts     # PluginContext factory
├── plugin-store.ts       # DB-backed key-value store
└── builtin/
    ├── index.ts           # Export all built-in plugins
    └── repo-sync/
        ├── index.ts       # Plugin entry point
        ├── manifest.ts    # Plugin manifest
        └── sync-job.ts    # Sync worker job
```

### 4.2 Loading Flow

```
App Startup
  → PluginLoader.discoverPlugins()
    → Scan builtin/ directory
    → (future: scan node_modules for agendo-plugin-* packages)
  → For each discovered plugin:
    → Validate manifest (version compatibility, required fields)
    → Check DB for enabled/disabled status
    → If enabled:
      → Create PluginContext
      → Call plugin.activate(ctx)
      → Register in PluginRegistry
  → Log summary: "Loaded N plugins (M enabled, K disabled)"
```

### 4.3 Enable/Disable

- State stored in `plugins` DB table (not filesystem)
- Disabling calls `plugin.deactivate()`, unregisters hooks/jobs/tools
- Re-enabling calls `plugin.activate()` again
- Configuration persisted in `plugins.config` JSONB column

---

## 5. Isolation Model

### 5.1 In-Process with Error Boundaries

For v1, plugins run in-process (same Node.js worker/app process) but with error boundaries:

1. **Try-catch wrapping** — all plugin hook invocations are wrapped in try-catch
2. **Timeout enforcement** — plugin hooks have a configurable timeout (default 30s)
3. **Error counting** — plugins that error too frequently (>10 errors/hour) are auto-disabled
4. **Scoped logging** — all plugin output goes through a prefixed logger

### 5.2 Why Not Process Isolation (v1)?

- Agendo already uses process isolation for agent subprocesses (Claude, Codex, Gemini)
- Built-in plugins are trusted code (shipped with the app)
- Process isolation adds IPC complexity and latency
- Can be added in v2 for community/untrusted plugins

### 5.3 Future: Worker Thread Isolation (v2)

For untrusted plugins, run in a Node.js Worker Thread with:
- Restricted `require()` (no fs, no net by default)
- Message-passing API (no shared memory)
- CPU/memory limits via worker options
- Automatic restart on crash

---

## 6. Database Schema

### 6.1 `plugins` Table

```sql
CREATE TABLE plugins (
  id          TEXT PRIMARY KEY,           -- manifest.id (e.g., 'repo-sync')
  name        TEXT NOT NULL,              -- manifest.name
  description TEXT,
  version     TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}', -- user configuration
  metadata    JSONB NOT NULL DEFAULT '{}', -- icon, category, etc.
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  last_error_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6.2 `plugin_store` Table

```sql
CREATE TABLE plugin_store (
  plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, key)
);
```

---

## 7. API Routes

```
GET    /api/plugins                    — List all plugins (with status)
PATCH  /api/plugins/:id               — Enable/disable, update config
GET    /api/plugins/:id               — Get plugin details
POST   /api/plugins/:id/actions/:action — Trigger plugin-specific actions
```

---

## 8. Settings UI

The plugins page (`/settings/plugins`) shows:

1. **Plugin list** — cards with name, description, icon, version, enabled toggle
2. **Plugin detail** — click to expand: config form (auto-generated from JSON Schema), error log, actions
3. **Status indicators** — green (active), gray (disabled), red (errored)

---

## 9. Sample Plugin: repo-sync

The first plugin demonstrates all extension points:

```typescript
// src/lib/plugins/builtin/repo-sync/index.ts
import { AgendoPlugin, PluginContext } from '../../types';
import { manifest } from './manifest';

export default {
  manifest,

  async activate(ctx: PluginContext) {
    // 1. Register a scheduled job to sync repos
    ctx.jobs.register('repo-sync:pull', async (job) => {
      const repos = await ctx.store.list('repos:');
      for (const { key, value } of repos) {
        // git pull logic with error handling
      }
    }, { cron: ctx.config.syncInterval || '0 */6 * * *' });

    // 2. Register an MCP tool for agents to trigger sync
    ctx.mcpTools.register({
      name: 'sync_repo',
      description: 'Trigger a git pull for a tracked repository',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string', description: 'Path to the git repository' },
        },
        required: ['repoPath'],
      },
      handler: async (input) => {
        // git pull + return status
      },
    });

    // 3. Hook into project creation to auto-track repos
    ctx.hooks.on('project:created', async (project) => {
      if (project.rootPath) {
        await ctx.store.set(`repos:${project.id}`, {
          path: project.rootPath,
          lastSync: null,
        });
      }
    });

    ctx.logger.info('repo-sync plugin activated');
  },

  async deactivate() {
    // Jobs and hooks are auto-cleaned by the registry
  },
} satisfies AgendoPlugin;
```

---

## 10. Implementation Phases

### Phase 1: Core Framework (this task)
- Plugin types (`types.ts`)
- Plugin registry (`plugin-registry.ts`)
- Plugin loader (`plugin-loader.ts`)
- Plugin context factory (`plugin-context.ts`)
- DB schema (plugins + plugin_store tables)
- API routes (list, enable/disable, configure)
- Settings UI (plugin list page)
- repo-sync sample plugin

### Phase 2: Deep Integration
- Hook system wired into task-service, session-process
- MCP tool registration bridge (plugins → MCP server)
- Plugin store implementation
- Worker job registration bridge (plugins → pg-boss)

### Phase 3: External Plugins
- npm package discovery (`agendo-plugin-*`)
- Worker thread isolation for untrusted plugins
- Plugin versioning and compatibility checks
- Plugin marketplace UI

---

## 11. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Plugin location | `src/lib/plugins/builtin/` | Ships with app, no npm install needed |
| Isolation model | In-process + error boundaries | Simplicity; agents already process-isolated |
| State storage | PostgreSQL (plugins + plugin_store) | Consistent with rest of Agendo; survives restarts |
| Config format | JSON Schema → auto-generated UI | No custom UI code per plugin |
| Hook execution | Async, fire-and-forget | Plugins can't block core operations |
| Job engine | pg-boss (shared) | Already running; no new infrastructure |
| MCP tool bridge | HTTP API call | MCP server is a separate esbuild bundle |

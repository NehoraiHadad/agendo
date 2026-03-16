import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  smallint,
  integer,
  bigint,
  numeric,
  jsonb,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  AgentMetadata,
  AgentSessionConfig,
  TaskInputContext,
  PlanMetadata,
  PlanVersionMetadata,
  SnapshotFindings,
  WorkspaceLayout,
} from '../types';

/** Shape of a parsed CLI flag from --help output */
export interface ParsedFlag {
  flags: string[];
  description: string;
  takesValue: boolean;
  valueHint: string | null;
}

// ============================================================================
// Enums
// ============================================================================

export const brainstormStatusEnum = pgEnum('brainstorm_status', [
  'waiting', // Created, not yet started
  'active', // Orchestrator running, waves in progress
  'paused', // All agents converged or user paused
  'synthesizing', // Generating synthesis
  'ended', // Completed
]);

export const brainstormParticipantStatusEnum = pgEnum('brainstorm_participant_status', [
  'pending', // Session not yet created
  'active', // Session running, agent participating
  'passed', // Agent passed this wave
  'left', // Removed mid-brainstorm
]);

export const taskStatusEnum = pgEnum('task_status', [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
]);

export const sessionStatusEnum = pgEnum('session_status', [
  'active',
  'awaiting_input',
  'idle',
  'ended',
]);

export const agentKindEnum = pgEnum('agent_kind', ['builtin', 'custom']);

// How an agent was discovered: auto-scan, preset match, or manual add.
export const discoveryMethodEnum = pgEnum('discovery_method', ['preset', 'path_scan', 'manual']);

// ============================================================================
// Tables
// ============================================================================

// --- Agent Registry ---------------------------------------------------------

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().default('00000000-0000-0000-0000-000000000001'),
    workspaceId: uuid('workspace_id').notNull().default('00000000-0000-0000-0000-000000000001'),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    kind: agentKindEnum('kind').notNull().default('custom'),
    binaryPath: text('binary_path').notNull(),
    baseArgs: jsonb('base_args').notNull().$type<string[]>().default([]),
    workingDir: text('working_dir'),
    envAllowlist: jsonb('env_allowlist').notNull().$type<string[]>().default([]),
    isActive: boolean('is_active').notNull().default(true),
    // Worker checks before claiming: skip if agent has max_concurrent running executions.
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    // --- Discovery fields ---
    discoveryMethod: discoveryMethodEnum('discovery_method').notNull().default('manual'),
    version: text('version'), // Output of --version
    packageName: text('package_name'), // dpkg package name (e.g., 'git')
    packageSection: text('package_section'), // apt section (e.g., 'vcs', 'web')
    toolType: text('tool_type'), // cli-tool | ai-agent | daemon | shell-util
    // --- MCP integration ---
    // If true, this agent is launched with an --mcp-config pointing to the agenDo MCP server.
    mcpEnabled: boolean('mcp_enabled').notNull().default(false),
    // --- Session management (AI agents only) ---
    // CLI-only: Claude uses stream-json, Codex uses app-server, Gemini uses tmux send-keys.
    sessionConfig: jsonb('session_config').$type<AgentSessionConfig>(),
    lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
    parsedFlags: jsonb('parsed_flags').$type<ParsedFlag[]>().notNull().default([]),
    metadata: jsonb('metadata').notNull().$type<AgentMetadata>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_agents_workspace').on(table.workspaceId, table.isActive)],
);

// --- Projects ---------------------------------------------------------------
// A project groups tasks under a shared working directory and env configuration.

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  // Unique: prevents duplicate projects for the same directory.
  rootPath: text('root_path').notNull().unique(),
  envOverrides: jsonb('env_overrides').$type<Record<string, string>>().notNull().default({}),
  // Hex color for UI color-coding (e.g. '#6366f1').
  color: varchar('color', { length: 7 }).notNull().default('#6366f1'),
  icon: varchar('icon', { length: 50 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- Tasks ------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().default('00000000-0000-0000-0000-000000000001'),
    workspaceId: uuid('workspace_id').notNull().default('00000000-0000-0000-0000-000000000001'),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, {
      onDelete: 'set null',
    }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('todo'),
    priority: smallint('priority').notNull().default(3),
    // Sparse ordering (gaps of 1000) for drag-and-drop within Kanban columns.
    sortOrder: integer('sort_order').notNull().default(0),
    // Execution sequence number within a project (nullable = unordered).
    // Lower numbers execute first. Used for "Next up" indicator and dependency-aware scheduling.
    executionOrder: integer('execution_order'),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    inputContext: jsonb('input_context').notNull().$type<TaskInputContext>().default({}),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_tasks_board').on(table.workspaceId, table.status, table.sortOrder),
    index('idx_tasks_parent').on(table.parentTaskId),
    index('idx_tasks_project_id').on(table.projectId),
  ],
);

// --- Task Dependencies (DAG) -----------------------------------------------

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    check('no_self_dependency', sql`task_id <> depends_on_task_id`),
    // Cycle detection enforced in service layer via transactional DFS + row locking.
  ],
);

// --- Task Events (Audit Trail) ----------------------------------------------

export const taskEvents = pgTable(
  'task_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    actorId: uuid('actor_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_task_events_task').on(table.taskId, table.createdAt)],
);

// --- Worker Heartbeats ------------------------------------------------------

export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  currentExecutions: integer('current_executions').notNull().default(0),
  metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
});

// --- Worker Config ----------------------------------------------------------
// Runtime-tunable settings (complements Zod env config in src/lib/config.ts).

export const workerConfig = pgTable('worker_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- Sessions ---------------------------------------------------------------
// A session groups one or more executions under a single long-running agent
// process. Defined after executions so executions.sessionId can forward-ref.

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['conversation', 'execution', 'plan', 'integration', 'support'] })
      .notNull()
      .default('execution'),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    status: sessionStatusEnum('status').notNull().default('active'),
    pid: integer('pid'),
    workerId: text('worker_id'),
    sessionRef: text('session_ref'),
    eventSeq: integer('event_seq').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    idleTimeoutSec: integer('idle_timeout_sec').notNull().default(600),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    logFilePath: text('log_file_path'),
    totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 6 }),
    totalTurns: integer('total_turns').notNull().default(0),
    // Tool permission mode for this session.
    // 'bypassPermissions' / 'dontAsk' = auto-allow all tools (default — safe for trusted local use).
    // 'default' = ask user before each tool call (Claude emits control_request).
    // 'acceptEdits' = auto-allow file edits, ask for bash.
    // 'plan' = read-only: Claude can plan but cannot execute tools that modify the system.
    permissionMode: text('permission_mode', {
      enum: ['default', 'bypassPermissions', 'acceptEdits', 'plan', 'dontAsk'],
    })
      .notNull()
      .default('bypassPermissions'),
    // Tool names/patterns that have been "always allow"d during this session.
    // Persisted so approval survives process restarts.
    allowedTools: jsonb('allowed_tools').notNull().$type<string[]>().default([]),
    initialPrompt: text('initial_prompt'),
    // User-assigned display name for the session (optional)
    title: text('title'),
    // AI model reported by the agent CLI (e.g. "claude-sonnet-4-5-20250514").
    model: text('model'),
    // Claude --effort flag: controls depth of thinking and resource usage per session.
    effort: text('effort', { enum: ['low', 'medium', 'high'] }),
    // Server-side tool usage counters (from Claude's result.usage.server_tool_use).
    webSearchRequests: integer('web_search_requests').default(0),
    webFetchRequests: integer('web_fetch_requests').default(0),
    // Full path to the plan file captured when ExitPlanMode fires.
    planFilePath: text('plan_file_path'),
    totalDurationMs: integer('total_duration_ms'),
    tmuxSessionName: text('tmux_session_name'),
    // The session this was forked from, if any.
    parentSessionId: uuid('parent_session_id').references((): AnyPgColumn => sessions.id, {
      onDelete: 'set null',
    }),
    // The Claude CLI sessionRef to resume from with --fork-session on first start.
    // Set at fork creation time to parent.sessionRef. Cleared (implicitly superseded)
    // once the fork's own sessionRef is written by system:init.
    forkSourceRef: text('fork_source_ref'),
    // The assistant message UUID where the fork branches off from the parent session.
    // Used by the UI to truncate parent display items at the fork point.
    forkPointUuid: text('fork_point_uuid'),
    // Optional list of MCP server IDs to use for this session (overrides project defaults).
    mcpServerIds: jsonb('mcp_server_ids').$type<string[]>(),
    // When true, pass --worktree to CLIs that support native git worktree isolation (Claude only).
    useWorktree: boolean('use_worktree').notNull().default(false),
    // Maximum API spend in USD for this session (Claude SDK only). Agent stops when exceeded.
    maxBudgetUsd: numeric('max_budget_usd', { precision: 10, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_task').on(table.taskId, table.createdAt),
    index('idx_sessions_active').on(table.status, table.workerId),
    index('idx_sessions_heartbeat').on(table.heartbeatAt),
    index('idx_sessions_project').on(table.projectId, table.kind, table.createdAt),
  ],
);

// ─── Push Subscriptions ───────────────────────────────────────────────────────

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Agent IDE Tables
// ============================================================================

export const planStatusEnum = pgEnum('plan_status', [
  'draft',
  'ready',
  'stale',
  'executing',
  'done',
  'archived',
]);

// --- Plans ------------------------------------------------------------------
// Implementation plans that can be validated against the codebase and executed
// by an agent session.

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    status: planStatusEnum('status').notNull().default('draft'),
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    executingSessionId: uuid('executing_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    conversationSessionId: uuid('conversation_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    codebaseHash: text('codebase_hash'),
    metadata: jsonb('metadata').notNull().$type<PlanMetadata>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_plans_project').on(table.projectId, table.status, table.createdAt)],
);

// --- Plan Versions ----------------------------------------------------------
// Full content snapshots of each plan revision for history & diff.

export const planVersions = pgTable(
  'plan_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').notNull().$type<PlanVersionMetadata>().default({}),
  },
  (table) => [
    uniqueIndex('idx_plan_versions_unique').on(table.planId, table.version),
    index('idx_plan_versions_plan').on(table.planId, table.createdAt),
  ],
);

// --- Context Snapshots ------------------------------------------------------
// Save investigation context from sessions for later resumption.

export const contextSnapshots = pgTable(
  'context_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    keyFindings: jsonb('key_findings').notNull().$type<SnapshotFindings>().default({
      filesExplored: [],
      findings: [],
      hypotheses: [],
      nextSteps: [],
    }),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_snapshots_project').on(table.projectId, table.createdAt)],
);

// --- Artifacts --------------------------------------------------------------
// Visual artifacts (HTML/SVG) rendered inline in the chat interface.
// Created by agents via the render_artifact MCP tool.

export const artifactTypeEnum = pgEnum('artifact_type', ['html', 'svg']);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').references(() => plans.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    type: artifactTypeEnum('type').notNull().default('html'),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_artifacts_session').on(table.sessionId, table.createdAt),
    index('idx_artifacts_plan').on(table.planId, table.createdAt),
  ],
);

// --- Workspaces -------------------------------------------------------------
// Multi-agent grid layout for viewing multiple sessions simultaneously.

export const agentWorkspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    layout: jsonb('layout').notNull().$type<WorkspaceLayout>().default({ panels: [], gridCols: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_workspaces_project').on(table.projectId, table.isActive)],
);

// ============================================================================
// MCP Server Registry
// ============================================================================

export const mcpTransportTypeEnum = pgEnum('mcp_transport_type', ['stdio', 'http']);

// --- MCP Servers ------------------------------------------------------------
// Global registry of MCP server definitions available to agents.

export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  transportType: mcpTransportTypeEnum('transport_type').notNull().default('stdio'),
  // stdio fields
  command: text('command'),
  args: jsonb('args').$type<string[]>().default([]),
  env: jsonb('env').$type<Record<string, string>>().default({}),
  // http fields
  url: text('url'),
  headers: jsonb('headers').$type<Record<string, string>>().default({}),
  // config
  enabled: boolean('enabled').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Brainstorm Rooms
// ============================================================================

// --- Brainstorm Rooms -------------------------------------------------------
// A brainstorm room orchestrates a multi-model conversation. The orchestrator
// worker job manages waves, PASS detection, and message routing between
// participant agent sessions.

export const brainstormRooms = pgTable(
  'brainstorm_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    topic: text('topic').notNull(),
    status: brainstormStatusEnum('status').notNull().default('waiting'),
    currentWave: integer('current_wave').notNull().default(0),
    maxWaves: integer('max_waves').notNull().default(10),
    config: jsonb('config').notNull().$type<BrainstormConfig>().default({}),
    synthesis: text('synthesis'),
    logFilePath: text('log_file_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_brainstorm_rooms_project').on(table.projectId, table.status, table.createdAt),
  ],
);

// --- Brainstorm Participants ------------------------------------------------
// Each participant maps to one agent session in the room.

export const brainstormParticipants = pgTable(
  'brainstorm_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => brainstormRooms.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    model: text('model'),
    status: brainstormParticipantStatusEnum('status').notNull().default('pending'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_brainstorm_participants_room').on(table.roomId, table.status),
    uniqueIndex('idx_brainstorm_participants_room_agent').on(table.roomId, table.agentId),
  ],
);

/** brainstorm_rooms.config */
export interface BrainstormConfig {
  /** Per-agent wave timeout in seconds (default 120) */
  waveTimeoutSec?: number;
  /** Agent ID to use for synthesis (default: first participant) */
  synthesisAgentId?: string;
}

// ============================================================================
// MCP Server Registry
// ============================================================================

// --- Project MCP Servers ----------------------------------------------------
// Per-project MCP server enablement and env overrides.

export const projectMcpServers = pgTable(
  'project_mcp_servers',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    envOverrides: jsonb('env_overrides').$type<Record<string, string>>().default({}),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.mcpServerId] })],
);

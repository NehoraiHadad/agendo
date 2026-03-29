import {
  pgTable,
  pgEnum,
  unique,
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
import type { FallbackPolicy } from '@/lib/fallback/policy';

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

// How a capability was registered: manually created, built-in preset, scanned, etc.
export const capabilitySourceEnum = pgEnum('capability_source', [
  'manual',
  'builtin',
  'preset',
  'scan_help',
  'scan_completion',
  'scan_fig',
  'scan_mcp',
  'scan_man',
  'llm_generated',
]);

// Template = fire-and-forget CLI command; Prompt = interactive AI session.
export const interactionModeEnum = pgEnum('interaction_mode', ['template', 'prompt']);

export const delegationPolicyEnum = pgEnum('delegation_policy', [
  'forbid',
  'suggest',
  'allow',
  'auto',
]);

export const teamRoleEnum = pgEnum('team_role', ['lead', 'member']);

// Provider compatibility status for a capability.
export const supportStatusEnum = pgEnum('support_status', [
  'verified', // Tested and confirmed working
  'untested', // Not yet tested
  'unsupported', // Known to not work with this agent
]);

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

// --- Agent Capabilities -----------------------------------------------------
// Each row describes one thing an agent can do. Per-agent (not global) because
// each agent's adapter has different protocol capabilities.

export const agentCapabilities = pgTable(
  'agent_capabilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    source: capabilitySourceEnum('source').notNull().default('manual'),
    // Determines template vs prompt execution path in the worker.
    interactionMode: interactionModeEnum('interaction_mode').notNull().default('template'),
    // Nullable: prompt-mode capabilities have no command template.
    commandTokens: jsonb('command_tokens').$type<string[]>(),
    // Prompt-mode: template with placeholders like {{task_title}}.
    promptTemplate: text('prompt_template'),
    argsSchema: jsonb('args_schema')
      .notNull()
      .$type<import('../types').JsonSchemaObject>()
      .default({}),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    isEnabled: boolean('is_enabled').notNull().default(true),
    // 0=safe, 1=caution, 2=dangerous, 3=destructive.
    dangerLevel: smallint('danger_level').notNull().default(0),
    timeoutSec: integer('timeout_sec').notNull().default(300),
    maxOutputBytes: integer('max_output_bytes')
      .notNull()
      .default(10 * 1024 * 1024), // 10MB
    // --- Provider compatibility metadata ---
    supportStatus: supportStatusEnum('support_status').notNull().default('untested'),
    providerNotes: text('provider_notes'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_agent_capability_key').on(table.agentId, table.key),
    index('idx_capabilities_agent').on(table.agentId, table.isEnabled),
    // Template-mode must have command_tokens; prompt-mode may have null.
    check(
      'capability_mode_consistency',
      sql`(interaction_mode = 'template' AND command_tokens IS NOT NULL) OR (interaction_mode = 'prompt')`,
    ),
  ],
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
  // GitHub integration: "owner/repo" format, auto-detected from git remote.
  githubRepo: text('github_repo'),
  // ISO timestamp of last successful GitHub sync (polling cursor).
  githubSyncCursor: timestamp('github_sync_cursor', { withTimezone: true }),
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
    // Durable counter: how many times this session was auto-resumed after a
    // mid-turn interruption (worker restart, crash, etc.). Incremented by
    // handleReEnqueue / zombie-reconciler. Reset to 0 on successful turn
    // (transitionTo 'awaiting_input'). Prevents infinite restart loops.
    autoResumeCount: integer('auto_resume_count').notNull().default(0),
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
    // Delegation policy controlling team tool visibility in preambles.
    // 'forbid' = suppress team tool mentions (default), 'suggest' = lightweight hints,
    // 'allow' = same as suggest, 'auto' = full team-lead preamble.
    delegationPolicy: delegationPolicyEnum('delegation_policy').notNull().default('forbid'),
    // Team role for this session. 'lead' = orchestrator, 'member' = team worker, null = not in a team.
    teamRole: teamRoleEnum('team_role'),
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
    outcome: jsonb('outcome').$type<BrainstormOutcome>(),
    logFilePath: text('log_file_path'),
    leaderParticipantId: uuid('leader_participant_id'),
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
    role: text('role'),
    status: brainstormParticipantStatusEnum('status').notNull().default('pending'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_brainstorm_participants_room').on(table.roomId, table.status),
    index('idx_brainstorm_participants_room_agent').on(table.roomId, table.agentId),
  ],
);

/** brainstorm_rooms.outcome — structured outcome data for post-hoc analysis */
export interface BrainstormOutcome {
  endState: 'converged' | 'max_waves' | 'stalled' | 'manual_end' | 'error';
  totalWaves: number;
  totalParticipants: number;
  activeParticipantsAtEnd: number;
  evictedCount: number;
  timeoutCount: number;
  synthesisParseSuccess: boolean;
  taskCreationCount: number;
  totalDurationMs: number;
  convergenceWave: number | null;
  reflectionWavesTriggered: number;
  deliverableType: string | null;
}

/** brainstorm_rooms.config — the "Playbook" schema for configuring brainstorm mechanics */
export interface BrainstormConfig {
  /** Per-agent wave timeout in seconds (default 120) */
  waveTimeoutSec?: number;
  /** Extra timeout for wave 0 / research wave in seconds (default 180) */
  wave0ExtraTimeoutSec?: number;
  /** Convergence mode: 'unanimous' = all must PASS, 'majority' = >50% PASS (default 'unanimous') */
  convergenceMode?: 'unanimous' | 'majority';
  /** Minimum waves before convergence can trigger (default 2) */
  minWavesBeforePass?: number;
  /** Number of required objections to block convergence (default 0) */
  requiredObjections?: number;
  /** Synthesis mode: 'single' = one agent, 'validated' = synthesize then validate (default 'single') */
  synthesisMode?: 'single' | 'validated';
  /** Agent ID to use for synthesis (default: first participant) */
  synthesisAgentId?: string;
  /** Language instruction injected into preamble (e.g. "Respond in Spanish") */
  language?: string;
  /** Role assignments: role label → agent slug (e.g. { critic: 'claude-code-1' }) */
  roles?: Record<string, string>;
  /** Startup timeout per participant in seconds (default 300) */
  participantReadyTimeoutSec?: number;
  /** IDs of related brainstorm rooms whose syntheses provide context (max 3) */
  relatedRoomIds?: string[];
  /** Enable reactive injection: inject responses into other agents immediately (default false) */
  reactiveInjection?: boolean;
  /** Max responses per agent per wave when reactive injection is enabled (default 2) */
  maxResponsesPerWave?: number;
  /** Number of consecutive timeouts before a participant is auto-evicted (default 2) */
  evictionThreshold?: number;
  /** Custom role instructions overriding defaults: role label → instruction text */
  roleInstructions?: Record<string, string>;
  /** Seconds to pause after each wave for user feedback (0 = no pause, default 0) */
  reviewPauseSec?: number;
  /** What specific outcome is expected from this brainstorm */
  goal?: string;
  /** Constraints that apply: time, scope, tech stack, etc */
  constraints?: string[];
  /** Type of output expected from synthesis */
  deliverableType?: 'decision' | 'options_list' | 'action_plan' | 'risk_assessment' | 'exploration';
  /** Who will use the output — affects language/depth in synthesis */
  targetAudience?: string;
  /** Enable automatic reflection waves when discussion stalls (default true) */
  autoReflection?: boolean;
  /** Minimum waves between reflection injections (default 3) */
  reflectionInterval?: number;
  /** Automatic recovery policy for explicit provider/model/agent failures */
  fallback?: FallbackPolicy;
}

// ============================================================================
// MCP Server Registry
// ============================================================================

// --- Project MCP Servers ----------------------------------------------------
// Per-project MCP server enablement and env overrides.

// --- Audit Log ---------------------------------------------------------------
// Fire-and-forget audit trail for key system actions.

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actor: varchar('actor', { length: 255 }),
    action: varchar('action', { length: 255 }).notNull(),
    resourceType: varchar('resource_type', { length: 100 }).notNull(),
    resourceId: uuid('resource_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_log_actor').on(table.actor),
    index('idx_audit_log_resource_type').on(table.resourceType),
    index('idx_audit_log_created_at').on(table.createdAt),
  ],
);

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

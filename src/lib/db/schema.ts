import {
  pgTable, pgEnum, uuid, text, boolean, smallint, integer,
  bigint, jsonb, timestamp, primaryKey, unique, index, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  AgentMetadata,
  AgentSessionConfig,
  TaskInputContext,
  JsonSchemaObject,
} from '../types';

// ============================================================================
// Enums
// ============================================================================

export const taskStatusEnum = pgEnum('task_status', [
  'todo', 'in_progress', 'blocked', 'done', 'cancelled',
]);

// 'cancelling' enables graceful shutdown: API sets cancelling -> worker SIGTERMs.
export const executionStatusEnum = pgEnum('execution_status', [
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out',
]);

// 'template' = CLI tools with command_tokens; 'prompt' = AI agents with free-form prompt.
export const interactionModeEnum = pgEnum('interaction_mode', [
  'template', 'prompt',
]);

export const agentKindEnum = pgEnum('agent_kind', [
  'builtin', 'custom',
]);

export const capabilitySourceEnum = pgEnum('capability_source', [
  'manual', 'builtin', 'preset', 'scan_help', 'scan_completion',
  'scan_fig', 'scan_mcp', 'scan_man', 'llm_generated',
]);

// How an agent was discovered: auto-scan, preset match, or manual add.
export const discoveryMethodEnum = pgEnum('discovery_method', [
  'preset', 'path_scan', 'manual',
]);

// ============================================================================
// Tables
// ============================================================================

// --- Agent Registry ---------------------------------------------------------

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull()
    .default('00000000-0000-0000-0000-000000000001'),
  workspaceId: uuid('workspace_id').notNull()
    .default('00000000-0000-0000-0000-000000000001'),
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
  version: text('version'),                    // Output of --version
  packageName: text('package_name'),            // dpkg package name (e.g., 'git')
  packageSection: text('package_section'),      // apt section (e.g., 'vcs', 'web')
  toolType: text('tool_type'),                  // cli-tool | ai-agent | daemon | shell-util
  // --- MCP integration ---
  // If true, this agent is launched with an --mcp-config pointing to the Agent Monitor MCP server.
  mcpEnabled: boolean('mcp_enabled').notNull().default(false),
  // --- Session management (AI agents only) ---
  // CLI-only: Claude uses stream-json, Codex uses app-server, Gemini uses tmux send-keys.
  sessionConfig: jsonb('session_config').$type<AgentSessionConfig>(),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().$type<AgentMetadata>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_agents_workspace').on(table.workspaceId, table.isActive),
]);

// --- Agent Capabilities -----------------------------------------------------

export const agentCapabilities = pgTable('agent_capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  source: capabilitySourceEnum('source').notNull(),
  // Determines template vs prompt execution path in the worker.
  interactionMode: interactionModeEnum('interaction_mode').notNull().default('template'),
  // Nullable: prompt-mode capabilities have no command template.
  commandTokens: jsonb('command_tokens').$type<string[]>(),
  // Prompt-mode: template with placeholders like {{task_title}}, {{input_context.prompt_additions}}.
  promptTemplate: text('prompt_template'),
  argsSchema: jsonb('args_schema').notNull().$type<JsonSchemaObject>().default({}),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  isEnabled: boolean('is_enabled').notNull().default(true),
  // 0=safe, 1=caution, 2=dangerous, 3=destructive.
  dangerLevel: smallint('danger_level').notNull().default(0),
  timeoutSec: integer('timeout_sec').notNull().default(300),
  maxOutputBytes: integer('max_output_bytes').notNull().default(10 * 1024 * 1024), // 10MB
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('uq_agent_capability_key').on(table.agentId, table.key),
  index('idx_capabilities_agent').on(table.agentId, table.isEnabled),
  // Template-mode must have command_tokens; prompt-mode may have null.
  check(
    'capability_mode_consistency',
    sql`(interaction_mode = 'template' AND command_tokens IS NOT NULL) OR (interaction_mode = 'prompt')`,
  ),
]);

// --- Tasks ------------------------------------------------------------------

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull()
    .default('00000000-0000-0000-0000-000000000001'),
  workspaceId: uuid('workspace_id').notNull()
    .default('00000000-0000-0000-0000-000000000001'),
  parentTaskId: uuid('parent_task_id')
    .references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  status: taskStatusEnum('status').notNull().default('todo'),
  priority: smallint('priority').notNull().default(3),
  // Sparse ordering (gaps of 1000) for drag-and-drop within Kanban columns.
  sortOrder: integer('sort_order').notNull().default(0),
  assigneeAgentId: uuid('assignee_agent_id')
    .references(() => agents.id, { onDelete: 'set null' }),
  inputContext: jsonb('input_context').notNull()
    .$type<TaskInputContext>().default({}),
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_tasks_board').on(table.workspaceId, table.status, table.sortOrder),
  index('idx_tasks_parent').on(table.parentTaskId),
]);

// --- Task Dependencies (DAG) -----------------------------------------------

export const taskDependencies = pgTable('task_dependencies', {
  taskId: uuid('task_id').notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: uuid('depends_on_task_id').notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
  check('no_self_dependency', sql`task_id <> depends_on_task_id`),
  // Cycle detection enforced in service layer via transactional DFS + row locking.
]);

// --- Executions -------------------------------------------------------------
// State machine: see 02-architecture.md for full transition rules.
// Log fields merged here (execution_logs table removed — 1:1 split was unnecessary).

export const executions = pgTable('executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull()
    .references(() => agents.id),
  capabilityId: uuid('capability_id').notNull()
    .references(() => agentCapabilities.id),
  requestedBy: uuid('requested_by').notNull()
    .default('00000000-0000-0000-0000-000000000001'),
  status: executionStatusEnum('status').notNull().default('queued'),
  // Denormalized from capability at queue time; preserves history if capability changes.
  mode: interactionModeEnum('mode').notNull().default('template'),
  args: jsonb('args').notNull().$type<Record<string, unknown>>().default({}),
  // Resolved prompt sent to AI agent (prompt-mode only).
  prompt: text('prompt'),
  // OS PID for SIGTERM/SIGKILL on cancel (tmux session PID or child_process PID).
  pid: integer('pid'),
  // External session ID (e.g. Claude session UUID) for session resume.
  sessionRef: text('session_ref'),
  // tmux session name for this execution (all AI agents run inside tmux for web terminal access).
  tmuxSessionName: text('tmux_session_name'),
  // Links to previous execution when continuing a session (continuation chain).
  parentExecutionId: uuid('parent_execution_id')
    .references((): AnyPgColumn => executions.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  exitCode: integer('exit_code'),
  // One-line error summary; full output in log file.
  error: text('error'),
  workerId: text('worker_id'),
  // Updated every 30s; stale jobs (>2min) reclaimed by stale-job-reaper.
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),

  // --- Log fields (merged from execution_logs) ---
  logFilePath: text('log_file_path'),
  logByteSize: bigint('log_byte_size', { mode: 'number' }).notNull().default(0),
  logLineCount: integer('log_line_count').notNull().default(0),
  logUpdatedAt: timestamp('log_updated_at', { withTimezone: true }),

  // --- Retry support ---
  // On failure: if retry_count < max_retries, worker requeues and increments.
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Job claim: partial on 'queued' for fast SKIP LOCKED queries.
  index('idx_executions_queue').on(table.status, table.createdAt),
  index('idx_executions_task').on(table.taskId, table.createdAt),
  // Stale job detection: running executions ordered by heartbeat.
  index('idx_executions_stale').on(table.heartbeatAt),
  // Per-agent concurrency check in claim query.
  index('idx_executions_agent_active').on(table.agentId, table.status),
]);

// --- Task Events (Audit Trail) ----------------------------------------------

export const taskEvents = pgTable('task_events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  taskId: uuid('task_id').notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  actorId: uuid('actor_id'),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_task_events_task').on(table.taskId, table.createdAt),
]);

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

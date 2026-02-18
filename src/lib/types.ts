import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type * as schema from './db/schema';

// ---- DB row types ----
export type Agent = InferSelectModel<typeof schema.agents>;
export type AgentCapability = InferSelectModel<typeof schema.agentCapabilities>;
export type Task = InferSelectModel<typeof schema.tasks>;
export type Execution = InferSelectModel<typeof schema.executions>;
export type TaskEvent = InferSelectModel<typeof schema.taskEvents>;
export type WorkerHeartbeat = InferSelectModel<typeof schema.workerHeartbeats>;
export type Session = InferSelectModel<typeof schema.sessions>;

export type NewAgent = InferInsertModel<typeof schema.agents>;
export type NewCapability = InferInsertModel<typeof schema.agentCapabilities>;
export type NewTask = InferInsertModel<typeof schema.tasks>;
export type NewExecution = InferInsertModel<typeof schema.executions>;
export type NewSession = InferInsertModel<typeof schema.sessions>;

// ---- Enum value types ----
export type TaskStatus = (typeof schema.taskStatusEnum.enumValues)[number];
export type ExecutionStatus = (typeof schema.executionStatusEnum.enumValues)[number];
export type InteractionMode = (typeof schema.interactionModeEnum.enumValues)[number];
export type AgentKind = (typeof schema.agentKindEnum.enumValues)[number];
export type CapabilitySource = (typeof schema.capabilitySourceEnum.enumValues)[number];
export type DiscoveryMethod = (typeof schema.discoveryMethodEnum.enumValues)[number];
export type SessionStatus = (typeof schema.sessionStatusEnum.enumValues)[number];

// ---- Domain types ----

/** agents.session_config */
export interface AgentSessionConfig {
  sessionIdSource: 'json_field' | 'filesystem' | 'list_command' | 'none';
  sessionIdField?: string;
  sessionFileGlob?: string;
  listSessionsCommand?: string[];
  listSessionsPattern?: string;
  resumeFlags?: string[];
  continueFlags?: string[];
  bidirectionalProtocol?: 'stream-json' | 'app-server' | 'tmux';
}

/** agents.metadata */
export interface AgentMetadata {
  icon?: string;
  color?: string;
  description?: string;
  homepage?: string;
}

/** tasks.input_context */
export interface TaskInputContext {
  workingDir?: string;
  envOverrides?: Record<string, string>;
  args?: Record<string, unknown>;
  promptAdditions?: string;
}

/** agent_capabilities.args_schema */
export interface JsonSchemaObject {
  type?: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** SSE log streaming event types */
export type SseLogEvent =
  | { type: 'status'; status: ExecutionStatus }
  | { type: 'catchup'; content: string }
  | { type: 'log'; content: string; stream: 'stdout' | 'stderr' | 'system' }
  | { type: 'done'; status: ExecutionStatus; exitCode: number | null }
  | { type: 'error'; message: string };

/** Task with related data for detail views */
export interface TaskWithDetails extends Task {
  assigneeAgent: Agent | null;
  subtasks: Task[];
  dependsOn: Task[];
  blockedBy: Task[];
  recentExecutions: Execution[];
}

/** Execution with related data */
export interface ExecutionWithDetails extends Execution {
  agent: Agent;
  capability: AgentCapability;
  task: Task;
}

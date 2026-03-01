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
export type Project = InferSelectModel<typeof schema.projects>;

export type NewAgent = InferInsertModel<typeof schema.agents>;
export type NewCapability = InferInsertModel<typeof schema.agentCapabilities>;
export type NewTask = InferInsertModel<typeof schema.tasks>;
export type NewExecution = InferInsertModel<typeof schema.executions>;
export type NewSession = InferInsertModel<typeof schema.sessions>;
export type NewProject = InferInsertModel<typeof schema.projects>;
export type Plan = InferSelectModel<typeof schema.plans>;
export type NewPlan = InferInsertModel<typeof schema.plans>;
export type ContextSnapshot = InferSelectModel<typeof schema.contextSnapshots>;
export type NewContextSnapshot = InferInsertModel<typeof schema.contextSnapshots>;
export type AgentWorkspace = InferSelectModel<typeof schema.agentWorkspaces>;
export type NewAgentWorkspace = InferInsertModel<typeof schema.agentWorkspaces>;

// ---- Enum value types ----
export type TaskStatus = (typeof schema.taskStatusEnum.enumValues)[number];
export type ExecutionStatus = (typeof schema.executionStatusEnum.enumValues)[number];
export type InteractionMode = (typeof schema.interactionModeEnum.enumValues)[number];
export type AgentKind = (typeof schema.agentKindEnum.enumValues)[number];
export type CapabilitySource = (typeof schema.capabilitySourceEnum.enumValues)[number];
export type DiscoveryMethod = (typeof schema.discoveryMethodEnum.enumValues)[number];
export type SessionStatus = (typeof schema.sessionStatusEnum.enumValues)[number];
export type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

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

// ---- Agent IDE types ----

/** plans.metadata */
export interface PlanMetadata {
  tags?: string[];
  notes?: string;
  executingTaskId?: string;
}

/** context_snapshots.key_findings */
export interface SnapshotFindings {
  filesExplored: string[];
  findings: string[];
  hypotheses: string[];
  nextSteps: string[];
}

/** workspaces.layout panel entry (react-grid-layout format) */
export interface WorkspacePanel {
  sessionId: string;
  /** Column position (0-based) */
  x: number;
  /** Row position in grid units (0-based) */
  y: number;
  /** Width in grid-column units */
  w: number;
  /** Height in row units (1 unit = ROW_HEIGHT px) */
  h: number;
}

/** workspaces.layout */
export interface WorkspaceLayout {
  panels: WorkspacePanel[];
  gridCols: 2 | 3;
}

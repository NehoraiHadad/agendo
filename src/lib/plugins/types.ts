import type { JSONSchema7 } from 'json-schema';

// ============================================================================
// Plugin Manifest
// ============================================================================

export interface PluginManifest {
  /** Unique identifier (kebab-case, e.g., 'repo-sync'). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description shown in settings UI. */
  description: string;
  /** SemVer version string. */
  version: string;
  /** Minimum Agendo version required. */
  minAgendoVersion?: string;
  /** Lucide icon name for the settings UI. */
  icon?: string;
  /** Plugin category for grouping. */
  category?: PluginCategory;
  /** JSON Schema for plugin-specific configuration. */
  configSchema?: JSONSchema7;
  /** Default configuration values. */
  defaultConfig?: Record<string, unknown>;
}

export type PluginCategory = 'integration' | 'automation' | 'agent' | 'utility';

// ============================================================================
// Plugin Lifecycle
// ============================================================================

export interface AgendoPlugin {
  manifest: PluginManifest;

  /**
   * Called when the plugin is loaded and enabled.
   * Register hooks, jobs, MCP tools here.
   */
  activate(ctx: PluginContext): Promise<void>;

  /**
   * Called when the plugin is disabled or app shuts down.
   * Clean up resources. Hooks/jobs are auto-unregistered by the registry.
   */
  deactivate?(): Promise<void>;

  /**
   * Called when plugin configuration changes at runtime.
   */
  onConfigChange?(config: Record<string, unknown>): Promise<void>;
}

// ============================================================================
// Plugin Context (provided by host to plugin)
// ============================================================================

export interface PluginContext {
  /** Plugin's own configuration. */
  config: Record<string, unknown>;

  /** Scoped logger (prefixed with plugin ID). */
  logger: PluginLogger;

  /** Register lifecycle hooks on Agendo events. */
  hooks: HookRegistry;

  /** Register pg-boss worker jobs. */
  jobs: JobRegistry;

  /** Register MCP tools for AI agents. */
  mcpTools: McpToolRegistry;

  /** Key-value storage scoped to this plugin. */
  store: PluginStore;
}

// ============================================================================
// Logger
// ============================================================================

export interface PluginLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

// ============================================================================
// Hook Registry
// ============================================================================

export type HookEvent =
  | 'task:created'
  | 'task:updated'
  | 'task:completed'
  | 'session:started'
  | 'session:ended'
  | 'project:created';

export interface HookRegistry {
  on(event: HookEvent, handler: (payload: unknown) => Promise<void>): void;
  off(event: HookEvent, handler: (payload: unknown) => Promise<void>): void;
}

// ============================================================================
// Job Registry
// ============================================================================

export interface JobOptions {
  // Cron schedule (e.g., '0 */6 * * *' for every 6 hours).
  cron?: string;
  /** Max retry count on failure. */
  retryLimit?: number;
  /** Retry delay in seconds. */
  retryDelay?: number;
  /** Job timeout in seconds. */
  expireInSeconds?: number;
}

export interface EnqueueOptions {
  /** Delay before processing (seconds). */
  startAfter?: number;
  /** Only keep one job with this key. */
  singletonKey?: string;
}

export type JobHandler = (data: unknown) => Promise<void>;

export interface JobRegistry {
  /** Register a new job type with a handler. */
  register(jobName: string, handler: JobHandler, options?: JobOptions): void;
  /** Enqueue a job for later processing. */
  enqueue(jobName: string, data: unknown, options?: EnqueueOptions): Promise<string>;
}

// ============================================================================
// MCP Tool Registry
// ============================================================================

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  handler: (
    input: Record<string, unknown>,
    context: McpToolContext,
  ) => Promise<unknown>;
}

export interface McpToolContext {
  /** The session ID that invoked the tool (if available). */
  sessionId?: string;
  /** The task ID associated with the session. */
  taskId?: string;
}

export interface McpToolRegistry {
  register(tool: McpToolDefinition): void;
  unregister(toolName: string): void;
}

// ============================================================================
// Plugin Store (scoped key-value storage)
// ============================================================================

export interface PluginStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

// ============================================================================
// Internal types (used by the registry/loader, not exposed to plugins)
// ============================================================================

export interface PluginRecord {
  id: string;
  name: string;
  description: string | null;
  version: string;
  enabled: boolean;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  errorCount: number;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PluginStatus = 'active' | 'disabled' | 'errored';

export interface PluginInfo {
  manifest: PluginManifest;
  status: PluginStatus;
  config: Record<string, unknown>;
  errorCount: number;
  lastError: string | null;
}

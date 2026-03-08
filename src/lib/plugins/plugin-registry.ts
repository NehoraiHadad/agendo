/**
 * Central plugin registry — tracks loaded plugins, their status, and
 * dispatches lifecycle hooks.
 */

import { createLogger } from '@/lib/logger';
import type {
  AgendoPlugin,
  HookEvent,
  PluginInfo,
  PluginStatus,
  McpToolDefinition,
  JobHandler,
  JobOptions,
} from './types';

const log = createLogger('plugin-registry');

const HOOK_TIMEOUT_MS = 30_000;
const MAX_ERRORS_PER_HOUR = 10;

interface RegisteredPlugin {
  plugin: AgendoPlugin;
  status: PluginStatus;
  config: Record<string, unknown>;
  errorCount: number;
  lastError: string | null;
  errorResetTimer?: ReturnType<typeof setTimeout>;
  hooks: Map<HookEvent, Array<(payload: unknown) => Promise<void>>>;
  jobs: Map<string, { handler: JobHandler; options?: JobOptions }>;
  mcpTools: Map<string, McpToolDefinition>;
}

class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  /** Register a plugin (does not activate it). */
  register(
    plugin: AgendoPlugin,
    config: Record<string, unknown>,
    status: PluginStatus = 'active',
  ): void {
    const { id } = plugin.manifest;
    if (this.plugins.has(id)) {
      log.warn({ pluginId: id }, 'Plugin already registered, replacing');
      this.unregister(id);
    }
    this.plugins.set(id, {
      plugin,
      status,
      config,
      errorCount: 0,
      lastError: null,
      hooks: new Map(),
      jobs: new Map(),
      mcpTools: new Map(),
    });
    log.info({ pluginId: id, version: plugin.manifest.version }, 'Plugin registered');
  }

  /** Unregister and clean up a plugin. */
  unregister(id: string): void {
    const entry = this.plugins.get(id);
    if (!entry) return;
    if (entry.errorResetTimer) clearTimeout(entry.errorResetTimer);
    this.plugins.delete(id);
    log.info({ pluginId: id }, 'Plugin unregistered');
  }

  /** Get a registered plugin entry. */
  get(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  /** List all registered plugins with their info. */
  list(): PluginInfo[] {
    return Array.from(this.plugins.values()).map(({ plugin, status, config, errorCount, lastError }) => ({
      manifest: plugin.manifest,
      status,
      config,
      errorCount,
      lastError,
    }));
  }

  /** Update a plugin's status. */
  setStatus(id: string, status: PluginStatus): void {
    const entry = this.plugins.get(id);
    if (entry) entry.status = status;
  }

  /** Update a plugin's config. */
  setConfig(id: string, config: Record<string, unknown>): void {
    const entry = this.plugins.get(id);
    if (entry) entry.config = config;
  }

  /** Record an error for a plugin. Auto-disables if too many errors. */
  recordError(id: string, error: string): boolean {
    const entry = this.plugins.get(id);
    if (!entry) return false;

    entry.errorCount++;
    entry.lastError = error;

    // Reset error count after 1 hour
    if (!entry.errorResetTimer) {
      entry.errorResetTimer = setTimeout(() => {
        entry.errorCount = 0;
        entry.errorResetTimer = undefined;
      }, 3_600_000);
    }

    if (entry.errorCount >= MAX_ERRORS_PER_HOUR) {
      entry.status = 'errored';
      log.error(
        { pluginId: id, errorCount: entry.errorCount },
        'Plugin auto-disabled due to excessive errors',
      );
      return true; // auto-disabled
    }
    return false;
  }

  // ---- Hook Management ----

  /** Register a hook handler for a plugin. */
  addHook(pluginId: string, event: HookEvent, handler: (payload: unknown) => Promise<void>): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    const handlers = entry.hooks.get(event) ?? [];
    handlers.push(handler);
    entry.hooks.set(event, handlers);
  }

  /** Remove a hook handler for a plugin. */
  removeHook(pluginId: string, event: HookEvent, handler: (payload: unknown) => Promise<void>): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    const handlers = entry.hooks.get(event);
    if (!handlers) return;
    entry.hooks.set(event, handlers.filter((h) => h !== handler));
  }

  /** Dispatch a hook event to all active plugins. Fire-and-forget with error isolation. */
  async dispatchHook(event: HookEvent, payload: unknown): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [pluginId, entry] of this.plugins) {
      if (entry.status !== 'active') continue;
      const handlers = entry.hooks.get(event);
      if (!handlers?.length) continue;

      for (const handler of handlers) {
        promises.push(
          Promise.race([
            handler(payload).catch((err: Error) => {
              const autoDisabled = this.recordError(pluginId, err.message);
              log.error(
                { pluginId, event, err: err.message, autoDisabled },
                'Plugin hook error',
              );
            }),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Hook timeout')), HOOK_TIMEOUT_MS),
            ).catch(() => {
              log.warn({ pluginId, event }, 'Plugin hook timed out');
            }),
          ]),
        );
      }
    }

    await Promise.allSettled(promises);
  }

  // ---- Job Management ----

  /** Register a job handler for a plugin. */
  addJob(pluginId: string, jobName: string, handler: JobHandler, options?: JobOptions): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    const qualifiedName = `plugin:${pluginId}:${jobName}`;
    entry.jobs.set(qualifiedName, { handler, options });
  }

  /** Get all registered jobs across all plugins. */
  getAllJobs(): Map<string, { handler: JobHandler; options?: JobOptions }> {
    const all = new Map<string, { handler: JobHandler; options?: JobOptions }>();
    for (const entry of this.plugins.values()) {
      if (entry.status !== 'active') continue;
      for (const [name, job] of entry.jobs) {
        all.set(name, job);
      }
    }
    return all;
  }

  // ---- MCP Tool Management ----

  /** Register an MCP tool for a plugin. */
  addMcpTool(pluginId: string, tool: McpToolDefinition): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    entry.mcpTools.set(tool.name, tool);
  }

  /** Unregister an MCP tool. */
  removeMcpTool(pluginId: string, toolName: string): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    entry.mcpTools.delete(toolName);
  }

  /** Get all registered MCP tools across all active plugins. */
  getAllMcpTools(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = [];
    for (const entry of this.plugins.values()) {
      if (entry.status !== 'active') continue;
      for (const tool of entry.mcpTools.values()) {
        tools.push(tool);
      }
    }
    return tools;
  }

  /** Clear all plugins (for shutdown). */
  clear(): void {
    for (const entry of this.plugins.values()) {
      if (entry.errorResetTimer) clearTimeout(entry.errorResetTimer);
    }
    this.plugins.clear();
  }
}

/** Singleton plugin registry. */
export const pluginRegistry = new PluginRegistry();

/**
 * Factory for creating scoped PluginContext instances.
 * Each plugin gets its own context with isolated logger, hook registration, etc.
 */

import { createLogger } from '@/lib/logger';
import { pluginRegistry } from './plugin-registry';
import { createPluginStore } from './plugin-store';
import type {
  PluginContext,
  PluginLogger,
  HookRegistry,
  HookEvent,
  JobRegistry,
  McpToolRegistry,
  JobHandler,
  JobOptions,
  EnqueueOptions,
  McpToolDefinition,
} from './types';

function createPluginLogger(pluginId: string): PluginLogger {
  const pino = createLogger(`plugin:${pluginId}`);
  return {
    info: (msg, data) => pino.info(data ?? {}, msg),
    warn: (msg, data) => pino.warn(data ?? {}, msg),
    error: (msg, data) => pino.error(data ?? {}, msg),
    debug: (msg, data) => pino.debug(data ?? {}, msg),
  };
}

function createHookRegistry(pluginId: string): HookRegistry {
  return {
    on(event: HookEvent, handler: (payload: unknown) => Promise<void>) {
      pluginRegistry.addHook(pluginId, event, handler);
    },
    off(event: HookEvent, handler: (payload: unknown) => Promise<void>) {
      pluginRegistry.removeHook(pluginId, event, handler);
    },
  };
}

function createJobRegistry(pluginId: string): JobRegistry {
  return {
    register(jobName: string, handler: JobHandler, options?: JobOptions) {
      pluginRegistry.addJob(pluginId, jobName, handler, options);
    },
    async enqueue(_jobName: string, _data: unknown, _options?: EnqueueOptions): Promise<string> {
      // TODO: Wire to pg-boss in phase 2
      return 'not-implemented';
    },
  };
}

function createMcpToolRegistry(pluginId: string): McpToolRegistry {
  return {
    register(tool: McpToolDefinition) {
      pluginRegistry.addMcpTool(pluginId, tool);
    },
    unregister(toolName: string) {
      pluginRegistry.removeMcpTool(pluginId, toolName);
    },
  };
}

/** Create a scoped PluginContext for a plugin. */
export function createPluginContext(
  pluginId: string,
  config: Record<string, unknown>,
): PluginContext {
  return {
    config,
    logger: createPluginLogger(pluginId),
    hooks: createHookRegistry(pluginId),
    jobs: createJobRegistry(pluginId),
    mcpTools: createMcpToolRegistry(pluginId),
    store: createPluginStore(pluginId),
  };
}

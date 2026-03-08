/**
 * Plugin discovery, loading, and lifecycle management.
 *
 * Built-in plugins are imported directly from builtin/.
 * Future: scan node_modules for agendo-plugin-* packages.
 */

import { db } from '@/lib/db';
import { plugins as pluginsTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { pluginRegistry } from './plugin-registry';
import { createPluginContext } from './plugin-context';
import { builtinPlugins } from './builtin';
import type { AgendoPlugin, PluginStatus } from './types';

const log = createLogger('plugin-loader');

/**
 * Discover and load all plugins.
 * Called once at app startup (both Next.js and worker).
 */
export async function loadPlugins(): Promise<void> {
  const discovered = discoverPlugins();
  log.info({ count: discovered.length }, 'Discovered plugins');

  let enabled = 0;
  let disabled = 0;

  for (const plugin of discovered) {
    try {
      const dbRecord = await getOrCreatePluginRecord(plugin);
      const status: PluginStatus = dbRecord.enabled ? 'active' : 'disabled';

      pluginRegistry.register(plugin, dbRecord.config, status);

      if (dbRecord.enabled) {
        const ctx = createPluginContext(plugin.manifest.id, dbRecord.config);
        await plugin.activate(ctx);
        enabled++;
      } else {
        disabled++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ pluginId: plugin.manifest.id, err: msg }, 'Failed to load plugin');
      pluginRegistry.register(plugin, {}, 'errored');
      await updatePluginError(plugin.manifest.id, msg);
    }
  }

  log.info({ enabled, disabled, total: discovered.length }, 'Plugin loading complete');
}

/**
 * Enable a plugin that was previously disabled.
 */
export async function enablePlugin(id: string): Promise<void> {
  const entry = pluginRegistry.get(id);
  if (!entry) throw new Error(`Plugin not found: ${id}`);

  const dbRecord = await getOrCreatePluginRecord(entry.plugin);
  const ctx = createPluginContext(id, dbRecord.config);

  try {
    await entry.plugin.activate(ctx);
    pluginRegistry.setStatus(id, 'active');
    await db.update(pluginsTable).set({ enabled: true, updatedAt: new Date() }).where(eq(pluginsTable.id, id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pluginRegistry.setStatus(id, 'errored');
    await updatePluginError(id, msg);
    throw err;
  }
}

/**
 * Disable an active plugin.
 */
export async function disablePlugin(id: string): Promise<void> {
  const entry = pluginRegistry.get(id);
  if (!entry) throw new Error(`Plugin not found: ${id}`);

  try {
    await entry.plugin.deactivate?.();
  } catch (err) {
    log.warn({ pluginId: id, err }, 'Error during plugin deactivation');
  }

  pluginRegistry.setStatus(id, 'disabled');
  await db.update(pluginsTable).set({ enabled: false, updatedAt: new Date() }).where(eq(pluginsTable.id, id));
}

/**
 * Update plugin configuration.
 */
export async function updatePluginConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<void> {
  const entry = pluginRegistry.get(id);
  if (!entry) throw new Error(`Plugin not found: ${id}`);

  await db
    .update(pluginsTable)
    .set({ config, updatedAt: new Date() })
    .where(eq(pluginsTable.id, id));

  pluginRegistry.setConfig(id, config);

  if (entry.status === 'active' && entry.plugin.onConfigChange) {
    try {
      await entry.plugin.onConfigChange(config);
    } catch (err) {
      log.error({ pluginId: id, err }, 'Error in plugin onConfigChange');
    }
  }
}

/**
 * Shut down all plugins gracefully.
 */
export async function shutdownPlugins(): Promise<void> {
  for (const info of pluginRegistry.list()) {
    if (info.status !== 'active') continue;
    const entry = pluginRegistry.get(info.manifest.id);
    if (!entry) continue;
    try {
      await entry.plugin.deactivate?.();
    } catch (err) {
      log.warn({ pluginId: info.manifest.id, err }, 'Error during plugin shutdown');
    }
  }
  pluginRegistry.clear();
  log.info('All plugins shut down');
}

// ---- Internal helpers ----

function discoverPlugins(): AgendoPlugin[] {
  // Phase 1: built-in plugins only
  // Phase 3: scan node_modules for agendo-plugin-* packages
  return [...builtinPlugins];
}

async function getOrCreatePluginRecord(plugin: AgendoPlugin) {
  const { id, name, description, version, icon, category, defaultConfig } = plugin.manifest;

  const existing = await db
    .select()
    .from(pluginsTable)
    .where(eq(pluginsTable.id, id))
    .limit(1);

  if (existing.length > 0) {
    // Update version/name if changed
    if (existing[0].version !== version || existing[0].name !== name) {
      await db
        .update(pluginsTable)
        .set({ version, name, description: description ?? null, updatedAt: new Date() })
        .where(eq(pluginsTable.id, id));
    }
    return existing[0];
  }

  // Create new record with defaults
  const record = {
    id,
    name,
    description: description ?? null,
    version,
    enabled: true,
    config: defaultConfig ?? {},
    metadata: { icon: icon ?? null, category: category ?? null },
    errorCount: 0,
    lastError: null,
    lastErrorAt: null,
  };

  await db.insert(pluginsTable).values(record);
  return { ...record, createdAt: new Date(), updatedAt: new Date() };
}

async function updatePluginError(id: string, error: string): Promise<void> {
  await db
    .update(pluginsTable)
    .set({
      lastError: error,
      lastErrorAt: new Date(),
      errorCount: 1,
      updatedAt: new Date(),
    })
    .where(eq(pluginsTable.id, id));
}

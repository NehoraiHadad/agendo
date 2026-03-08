/**
 * Service layer for plugin management.
 * Wraps plugin-loader operations with service-pattern conventions.
 */

import { db } from '@/lib/db';
import { plugins as pluginsTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { pluginRegistry } from '@/lib/plugins/plugin-registry';
import {
  enablePlugin,
  disablePlugin,
  updatePluginConfig,
} from '@/lib/plugins/plugin-loader';
import type { PluginInfo } from '@/lib/plugins/types';

export async function listPlugins(): Promise<PluginInfo[]> {
  return pluginRegistry.list();
}

export async function getPlugin(id: string): Promise<PluginInfo | null> {
  const list = pluginRegistry.list();
  return list.find((p) => p.manifest.id === id) ?? null;
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  if (enabled) {
    await enablePlugin(id);
  } else {
    await disablePlugin(id);
  }
}

export async function updateConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<void> {
  await updatePluginConfig(id, config);
}

export async function getPluginFromDb(id: string) {
  const rows = await db
    .select()
    .from(pluginsTable)
    .where(eq(pluginsTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

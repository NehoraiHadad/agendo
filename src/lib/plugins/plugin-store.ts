/**
 * DB-backed key-value store scoped to a plugin.
 * Uses the plugin_store table with (plugin_id, key) composite primary key.
 */

import { db } from '@/lib/db';
import { pluginStore as pluginStoreTable } from '@/lib/db/schema';
import { eq, and, like } from 'drizzle-orm';
import type { PluginStore } from './types';

export function createPluginStore(pluginId: string): PluginStore {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const rows = await db
        .select({ value: pluginStoreTable.value })
        .from(pluginStoreTable)
        .where(and(eq(pluginStoreTable.pluginId, pluginId), eq(pluginStoreTable.key, key)))
        .limit(1);
      return rows.length > 0 ? (rows[0].value as T) : null;
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      await db
        .insert(pluginStoreTable)
        .values({
          pluginId,
          key,
          value: value as unknown,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pluginStoreTable.pluginId, pluginStoreTable.key],
          set: {
            value: value as unknown,
            updatedAt: new Date(),
          },
        });
    },

    async delete(key: string): Promise<void> {
      await db
        .delete(pluginStoreTable)
        .where(and(eq(pluginStoreTable.pluginId, pluginId), eq(pluginStoreTable.key, key)));
    },

    async list(prefix?: string): Promise<Array<{ key: string; value: unknown }>> {
      const conditions = [eq(pluginStoreTable.pluginId, pluginId)];
      if (prefix) {
        conditions.push(like(pluginStoreTable.key, `${prefix}%`));
      }
      const rows = await db
        .select({ key: pluginStoreTable.key, value: pluginStoreTable.value })
        .from(pluginStoreTable)
        .where(and(...conditions));
      return rows;
    },
  };
}

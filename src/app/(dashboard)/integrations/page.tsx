import { db } from '@/lib/db';
import { tasks } from '@/lib/db/schema';
import { eq, and, sql, isNull, like } from 'drizzle-orm';
import { getOrCreateSystemProject } from '@/lib/services/project-service';
import { IntegrationsClient } from './integrations-client';
import type { Task } from '@/lib/types';

async function getIntegrations(): Promise<Task[]> {
  try {
    const systemProject = await getOrCreateSystemProject();
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, systemProject.id),
          sql`${tasks.inputContext}->'args'->>'integrationName' IS NOT NULL`,
          isNull(tasks.parentTaskId),
          like(tasks.title, 'Integrate:%'),
        ),
      )
      .orderBy(sql`${tasks.createdAt} DESC`);
    return rows as Task[];
  } catch {
    return [];
  }
}

export default async function IntegrationsPage() {
  const integrations = await getIntegrations();
  return <IntegrationsClient integrations={integrations} />;
}

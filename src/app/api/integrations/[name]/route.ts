import { NextRequest, NextResponse } from 'next/server';
import { sql, eq, and } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';
import { NotFoundError } from '@/lib/errors';
import { db } from '@/lib/db';
import { agents, agentCapabilities, tasks } from '@/lib/db/schema';
import { getOrCreateSystemProject } from '@/lib/services/project-service';
import { createTask } from '@/lib/services/task-service';
import { createAndEnqueueSession } from '@/lib/services/session-helpers';

/**
 * DELETE /api/integrations/[name]
 *
 * Spawns a repo-remover agent session to cleanly remove a previously installed integration.
 * The agent reads the original task snapshot (commits, filesCreated, dbRecords) and removes
 * everything surgically — warning if files were modified after the integration.
 *
 * Returns { data: { sessionId } } — caller can redirect to the session to watch progress.
 */
export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { name } = await params;

    const systemProject = await getOrCreateSystemProject();

    // Find the original integration task by integrationName in inputContext
    const [originalTask] = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, systemProject.id),
          sql`${tasks.inputContext}->'args'->>'integrationName' = ${name}`,
        ),
      )
      .limit(1);

    if (!originalTask) {
      throw new NotFoundError('Integration', name);
    }

    // Find any active agent with the repo-remover capability
    const removerRows = await db
      .select({ agentId: agents.id, capabilityId: agentCapabilities.id })
      .from(agentCapabilities)
      .innerJoin(agents, eq(agents.id, agentCapabilities.agentId))
      .where(
        and(
          eq(agentCapabilities.key, 'repo-remover'),
          eq(agentCapabilities.isEnabled, true),
          eq(agents.isActive, true),
        ),
      )
      .limit(1);

    if (removerRows.length === 0) {
      throw new NotFoundError('Capability', 'repo-remover');
    }

    const { agentId, capabilityId } = removerRows[0];

    // Remove the original integration task from the board so it no longer appears in the UI
    await db.delete(tasks).where(eq(tasks.id, originalTask.id));

    // Create a removal task under the system project
    const removalTask = await createTask({
      title: `Remove integration: ${name}`,
      description: `Cleanly remove the '${name}' repo integration from Agendo`,
      projectId: systemProject.id,
      assigneeAgentId: agentId,
      inputContext: {
        args: {
          integrationName: name,
          originalTaskId: originalTask.id,
        },
      },
    });

    const session = await createAndEnqueueSession({
      taskId: removalTask.id,
      projectId: systemProject.id,
      kind: 'conversation',
      agentId,
      capabilityId,
      permissionMode: 'bypassPermissions',
    });

    return NextResponse.json({ data: { sessionId: session.id, taskId: removalTask.id } });
  },
);

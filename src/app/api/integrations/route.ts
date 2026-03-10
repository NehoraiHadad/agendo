import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql, isNull } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';
import { NotFoundError } from '@/lib/errors';
import { createTask, updateTask } from '@/lib/services/task-service';
import { createAndEnqueueSession } from '@/lib/services/session-helpers';
import { getOrCreateSystemProject } from '@/lib/services/project-service';
import { db } from '@/lib/db';
import { agents, tasks } from '@/lib/db/schema';
import { eq, and, like } from 'drizzle-orm';

const postSchema = z.object({
  // Free-form: URL, package name, or natural language description
  source: z.string().min(3).max(2000),
  title: z.string().min(1).max(500).optional(),
  // Optional: pin to a specific agent; falls back to first available repo-planner
  agentId: z.string().uuid().optional(),
});

/**
 * Derives a slug for the integration name from the source string.
 * - URL  → last non-empty path segment (e.g. "linear-mcp")
 * - Text → first 3 meaningful words, joined with "-"
 */
function deriveIntegrationName(source: string): string {
  try {
    const url = new URL(source);
    const parts = url.pathname.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }
  } catch {
    // not a URL
  }
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join('-') || 'integration'
  );
}

/**
 * GET /api/integrations
 * Lists all integration tasks under the system project.
 */
export const GET = withErrorBoundary(async () => {
  const systemProject = await getOrCreateSystemProject();
  const integrationTasks = await db
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
  return NextResponse.json({ data: integrationTasks });
});

/**
 * POST /api/integrations
 *
 * Kicks off an integration analysis run:
 * 1. Derives an integration name from the source.
 * 2. Uses the built-in Agendo System project.
 * 3. Creates a planning task and enqueues a repo-planner session.
 * Returns { data: { taskId, sessionId } } with 201.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const { source, title, agentId: requestedAgentId } = postSchema.parse(body);

  const integrationName = deriveIntegrationName(source);
  const systemProject = await getOrCreateSystemProject();

  const agentRow = requestedAgentId
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, requestedAgentId), eq(agents.isActive, true)))
        .limit(1)
        .then((r) => r[0] ?? null)
    : await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.isActive, true), eq(agents.toolType, 'ai-agent')))
        .limit(1)
        .then((r) => r[0] ?? null);

  if (!agentRow) {
    throw new NotFoundError('Agent', requestedAgentId ?? 'active ai-agent');
  }
  const agentId = agentRow.id;

  const task = await createTask({
    title: title ?? `Integrate: ${integrationName}`,
    description: `Integration plan and execution for: ${source}\n\nIf the auto-derived task title does not accurately reflect the integration, call update_task with a better title (e.g. "Integrate: <proper-name>").`,
    projectId: systemProject.id,
    assigneeAgentId: agentId,
    inputContext: {
      args: {
        source,
        integrationName,
      },
    },
  });

  const session = await createAndEnqueueSession({
    taskId: task.id,
    projectId: systemProject.id,
    kind: 'conversation',
    agentId,
    permissionMode: 'plan',
  });

  // Store sessionId so the UI can link to the planner session.
  await updateTask(task.id, {
    inputContext: { args: { source, integrationName, sessionId: session.id } },
  });

  return NextResponse.json({ data: { taskId: task.id, sessionId: session.id } }, { status: 201 });
});

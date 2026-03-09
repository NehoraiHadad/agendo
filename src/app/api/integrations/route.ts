import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';
import { NotFoundError } from '@/lib/errors';
import { createTask } from '@/lib/services/task-service';
import { createAndEnqueueSession } from '@/lib/services/session-helpers';
import { getOrCreateSystemProject } from '@/lib/services/project-service';
import { db } from '@/lib/db';
import { agents, agentCapabilities, tasks } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

const postSchema = z.object({
  // Free-form: URL, package name, or natural language description
  source: z.string().min(3).max(2000),
  title: z.string().min(1).max(500).optional(),
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
  const { source, title } = postSchema.parse(body);

  const integrationName = deriveIntegrationName(source);
  const systemProject = await getOrCreateSystemProject();

  const plannerRows = await db
    .select({ agentId: agents.id, capabilityId: agentCapabilities.id })
    .from(agentCapabilities)
    .innerJoin(agents, eq(agents.id, agentCapabilities.agentId))
    .where(
      and(
        eq(agentCapabilities.key, 'repo-planner'),
        eq(agentCapabilities.isEnabled, true),
        eq(agents.isActive, true),
      ),
    )
    .limit(1);

  if (plannerRows.length === 0) {
    throw new NotFoundError('Capability', 'repo-planner');
  }

  const { agentId, capabilityId } = plannerRows[0];

  const task = await createTask({
    title: title ?? `Integrate: ${integrationName}`,
    description: `Integration plan and execution for: ${source}`,
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
    capabilityId,
    permissionMode: 'plan',
  });

  return NextResponse.json({ data: { taskId: task.id, sessionId: session.id } }, { status: 201 });
});

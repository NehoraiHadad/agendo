import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { sessions, agents, agentCapabilities, tasks, projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '@/lib/errors';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const [row] = await db
      .select({
        session: sessions,
        agentName: agents.name,
        agentSlug: agents.slug,
        capLabel: agentCapabilities.label,
        taskTitle: tasks.title,
        projectName: projects.name,
      })
      .from(sessions)
      .leftJoin(agents, eq(sessions.agentId, agents.id))
      .leftJoin(agentCapabilities, eq(sessions.capabilityId, agentCapabilities.id))
      .leftJoin(tasks, eq(sessions.taskId, tasks.id))
      .leftJoin(projects, eq(projects.id, sessions.projectId))
      .where(eq(sessions.id, id))
      .limit(1);

    if (!row) throw new NotFoundError('Session', id);

    return NextResponse.json({
      data: {
        ...row.session,
        agentName: row.agentName,
        agentSlug: row.agentSlug,
        capLabel: row.capLabel,
        taskTitle: row.taskTitle,
        projectName: row.projectName,
      },
    });
  },
);

const patchSchema = z.object({
  title: z.string().max(200).nullable(),
});

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = await req.json();
    const { title } = patchSchema.parse(body);

    const [updated] = await db
      .update(sessions)
      .set({ title })
      .where(eq(sessions.id, id))
      .returning({ id: sessions.id, title: sessions.title });

    if (!updated) throw new NotFoundError('Session', id);

    return NextResponse.json({ data: updated });
  },
);

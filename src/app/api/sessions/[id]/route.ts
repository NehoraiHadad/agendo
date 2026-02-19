import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { sessions, agents, agentCapabilities, tasks } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '@/lib/errors';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;

    const [row] = await db
      .select({
        session: sessions,
        agentName: agents.name,
        agentSlug: agents.slug,
        capLabel: agentCapabilities.label,
        taskTitle: tasks.title,
      })
      .from(sessions)
      .leftJoin(agents, eq(sessions.agentId, agents.id))
      .leftJoin(agentCapabilities, eq(sessions.capabilityId, agentCapabilities.id))
      .leftJoin(tasks, eq(sessions.taskId, tasks.id))
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
      },
    });
  },
);

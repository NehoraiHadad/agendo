export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { sessions, agents, tasks, projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SessionDetailWrapper } from './session-detail-wrapper';

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const rows = await db
    .select({
      session: sessions,
      agentName: agents.name,
      agentSlug: agents.slug,
      agentBinaryPath: agents.binaryPath,
      taskTitle: tasks.title,
      projectName: projects.name,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .leftJoin(tasks, eq(sessions.taskId, tasks.id))
    .leftJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(sessions.id, id))
    .limit(1);

  if (rows.length === 0) notFound();

  const { session, agentName, agentSlug, agentBinaryPath, taskTitle, projectName } = rows[0];

  // Fetch parent session agent name for lineage display
  let parentAgentName = '';
  const parentTurns: number | null = null;

  if (session.parentSessionId) {
    const parentRows = await db
      .select({ agentName: agents.name })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .where(eq(sessions.id, session.parentSessionId))
      .limit(1);

    if (parentRows.length > 0) {
      parentAgentName = parentRows[0].agentName;
    }
  }

  return (
    <SessionDetailWrapper
      session={session}
      agentName={agentName}
      agentSlug={agentSlug}
      agentBinaryPath={agentBinaryPath}
      taskTitle={taskTitle ?? ''}
      projectName={projectName ?? ''}
      parentAgentName={parentAgentName}
      parentTurns={parentTurns}
    />
  );
}

export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { sessions, agents, agentCapabilities, tasks } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SessionDetailWrapper } from './session-detail-wrapper';

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const rows = await db
    .select({
      session: sessions,
      agentName: agents.name,
      agentSlug: agents.slug,
      capLabel: agentCapabilities.label,
      taskTitle: tasks.title,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .innerJoin(agentCapabilities, eq(sessions.capabilityId, agentCapabilities.id))
    .innerJoin(tasks, eq(sessions.taskId, tasks.id))
    .where(eq(sessions.id, id))
    .limit(1);

  if (rows.length === 0) notFound();

  const { session, agentName, agentSlug, capLabel, taskTitle } = rows[0];

  return (
    <SessionDetailWrapper
      session={session}
      agentName={agentName}
      agentSlug={agentSlug}
      capLabel={capLabel}
      taskTitle={taskTitle}
    />
  );
}

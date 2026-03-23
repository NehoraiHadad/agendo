export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { sessions, tasks, agents } from '@/lib/db/schema';
import { eq, desc, and, isNotNull } from 'drizzle-orm';
import { TeamMonitorClient } from './team-monitor-client';
import type { SubtaskSession, ServerTeamMember } from '@/components/teams/team-monitor-canvas';

export default async function TeamMonitorPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;

  // Fetch the parent task
  const parentTaskRows = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (parentTaskRows.length === 0) notFound();

  const parentTask = parentTaskRows[0];

  // Fetch the latest session for this task (the team-lead session)
  const leadSessionRows = await db
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), isNotNull(sessions.taskId)))
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  const leadSession = leadSessionRows[0];

  if (!leadSession) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)] bg-[#0a0a0f] text-zinc-600">
        <div className="text-center space-y-2">
          <div className="text-4xl">🛰</div>
          <div className="text-sm">No session found for this task.</div>
          <div className="text-xs text-zinc-700">Start a team session first.</div>
        </div>
      </div>
    );
  }

  // Fetch subtasks with their agent + latest session data
  const subtaskRows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assigneeAgentId: tasks.assigneeAgentId,
    })
    .from(tasks)
    .where(eq(tasks.parentTaskId, taskId));

  const subtaskSessions: SubtaskSession[] = [];
  const teamMembers: ServerTeamMember[] = [];

  for (const subtask of subtaskRows) {
    if (!subtask.assigneeAgentId) continue;

    // Fetch the agent row for name + slug
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, subtask.assigneeAgentId))
      .limit(1);

    const agent = agentRows[0];

    // Fetch the latest session for this subtask (for stream + model)
    const subtaskSessionRows = await db
      .select({ id: sessions.id, status: sessions.status, model: sessions.model })
      .from(sessions)
      .where(eq(sessions.taskId, subtask.id))
      .orderBy(desc(sessions.createdAt))
      .limit(1);

    const subtaskSession = subtaskSessionRows[0];

    if (subtaskSession) {
      subtaskSessions.push({
        subtaskId: subtask.id,
        sessionId: subtaskSession.id,
        agentId: subtask.assigneeAgentId,
        status: subtaskSession.status,
      });

      teamMembers.push({
        agentId: subtask.assigneeAgentId,
        agentName: agent?.name ?? 'Unknown Agent',
        agentSlug: agent?.slug ?? '',
        role: subtask.title,
        sessionId: subtaskSession.id,
        sessionStatus: subtaskSession.status,
        model: subtaskSession.model ?? null,
        subtaskId: subtask.id,
      });
    }
  }

  return (
    <TeamMonitorClient
      leadSessionId={leadSession.id}
      subtaskSessions={subtaskSessions}
      taskId={taskId}
      taskTitle={parentTask.title}
      teamMembers={teamMembers}
    />
  );
}

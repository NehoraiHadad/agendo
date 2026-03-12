import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { searchTasks, searchProgressNotes } from '@/lib/services/task-service';
import { searchProjects } from '@/lib/services/project-service';
import { searchSessions } from '@/lib/services/session-service';
import { searchPlans } from '@/lib/services/plan-service';

const querySchema = z.object({
  q: z.string().min(2).max(60),
});

/** Strip a leading `-` from git-log-style hashes like `-490688e`. */
function normalizeQuery(raw: string): string {
  return /^-[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(1) : raw;
}

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ q: url.searchParams.get('q') ?? '' });

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'q must be 2–60 characters' } },
      { status: 400 },
    );
  }

  const q = normalizeQuery(parsed.data.q);

  const [rawTasks, rawProjects, rawSessions, rawPlans, rawNotes] = await Promise.all([
    searchTasks(q, 5),
    searchProjects(q, 5),
    searchSessions(q, 5),
    searchPlans(q, 5),
    searchProgressNotes(q, 5),
  ]);

  return NextResponse.json({
    data: {
      tasks: rawTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        meta: t.projectName ?? undefined,
      })),
      projects: rawProjects.map((p) => ({
        id: p.id,
        title: p.name,
        meta: p.description ?? undefined,
      })),
      sessions: rawSessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        meta: s.agentName,
      })),
      plans: rawPlans.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
      })),
      progressNotes: rawNotes.map((n) => ({
        // id = taskId so the UI can navigate directly to the task drawer
        id: n.taskId,
        title: n.taskTitle,
        status: n.taskStatus,
        meta: n.noteSnippet,
      })),
    },
  });
});

import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  createSession,
  listSessions,
  deleteSessions,
  type SessionKind,
} from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import { assertPromptModeCapability } from '@/lib/services/capability-service';
import { z } from 'zod';

const createSessionSchema = z.object({
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  kind: z.enum(['conversation', 'execution']).optional(),
  agentId: z.string().uuid(),
  capabilityId: z.string().uuid(),
  initialPrompt: z.string().optional(),
  permissionMode: z.enum(['default', 'bypassPermissions', 'acceptEdits']).optional(),
  allowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get('kind');
  const result = await listSessions({
    taskId: url.searchParams.get('taskId') ?? undefined,
    agentId: url.searchParams.get('agentId') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    kind:
      kindParam === 'conversation' || kindParam === 'execution'
        ? (kindParam as SessionKind)
        : undefined,
    page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
    pageSize: url.searchParams.has('pageSize')
      ? Number(url.searchParams.get('pageSize'))
      : undefined,
  });
  return NextResponse.json({
    data: result.data,
    meta: { total: result.total, page: result.page, pageSize: result.pageSize },
  });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createSessionSchema.parse(await req.json());

  await assertPromptModeCapability(body.capabilityId);

  const session = await createSession({
    taskId: body.taskId,
    projectId: body.projectId,
    kind: body.kind,
    agentId: body.agentId,
    capabilityId: body.capabilityId,
    initialPrompt: body.initialPrompt,
    permissionMode: body.permissionMode,
    allowedTools: body.allowedTools,
    model: body.model,
    effort: body.effort,
  });

  if (body.initialPrompt) {
    await enqueueSession({ sessionId: session.id });
  }

  return NextResponse.json({ data: { id: session.id } }, { status: 201 });
});

const bulkDeleteSchema = z.object({
  sessionIds: z.array(z.string().uuid()).min(1).max(100),
});

export const DELETE = withErrorBoundary(async (req: NextRequest) => {
  const body = bulkDeleteSchema.parse(await req.json());
  const result = await deleteSessions(body.sessionIds);
  return NextResponse.json({ data: result });
});

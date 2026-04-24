import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  createSession,
  listSessions,
  deleteSessions,
  type SessionKind,
} from '@/lib/services/session-service';
import { dispatchSession } from '@/lib/services/session-dispatch';
import { isDemoMode } from '@/lib/demo/flag';
import { z } from 'zod';

const createSessionSchema = z.object({
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  kind: z.enum(['conversation', 'execution', 'support']).optional(),
  agentId: z.string().uuid(),
  initialPrompt: z.string().optional(),
  permissionMode: z.enum(['default', 'bypassPermissions', 'acceptEdits']).optional(),
  allowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  parentSessionId: z.string().uuid().optional(),
  mcpServerIds: z.array(z.string().uuid()).optional(),
  useWorktree: z.boolean().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  delegationPolicy: z.enum(['forbid', 'suggest', 'allow', 'auto']).optional(),
  teamRole: z.enum(['lead', 'member']).optional(),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get('kind');
  const result = await listSessions({
    taskId: url.searchParams.get('taskId') ?? undefined,
    agentId: url.searchParams.get('agentId') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    kind:
      kindParam === 'conversation' || kindParam === 'execution' || kindParam === 'support'
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

  const session = await createSession({
    taskId: body.taskId,
    projectId: body.projectId,
    kind: body.kind,
    agentId: body.agentId,
    initialPrompt: body.initialPrompt,
    permissionMode: body.permissionMode,
    allowedTools: body.allowedTools,
    model: body.model,
    effort: body.effort,
    parentSessionId: body.parentSessionId,
    mcpServerIds: body.mcpServerIds,
    useWorktree: body.useWorktree,
    maxBudgetUsd: body.maxBudgetUsd,
    delegationPolicy: body.delegationPolicy,
    teamRole: body.teamRole,
  });

  if (body.initialPrompt && !isDemoMode()) {
    await dispatchSession({ sessionId: session.id, resumePrompt: body.initialPrompt });
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

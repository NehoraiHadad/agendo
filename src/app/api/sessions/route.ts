import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createSession, listSessions, type SessionKind } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import { db } from '@/lib/db';
import { agentCapabilities } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { BadRequestError } from '@/lib/errors';
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

  // Validate capability is prompt-mode
  const [cap] = await db
    .select({ interactionMode: agentCapabilities.interactionMode })
    .from(agentCapabilities)
    .where(eq(agentCapabilities.id, body.capabilityId))
    .limit(1);

  if (!cap) throw new BadRequestError('Capability not found');
  if (cap.interactionMode !== 'prompt') {
    throw new BadRequestError('Only prompt-mode capabilities can be used for sessions.');
  }

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
  });

  if (body.initialPrompt) {
    await enqueueSession({ sessionId: session.id });
  }

  return NextResponse.json({ data: { id: session.id } }, { status: 201 });
});

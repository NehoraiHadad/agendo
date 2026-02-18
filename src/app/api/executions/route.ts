import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listExecutions, createExecution } from '@/lib/services/execution-service';
import { enqueueExecution } from '@/lib/worker/queue';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { agentCapabilities } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createSession } from '@/lib/services/session-service';
import type { ExecutionStatus } from '@/lib/types';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const result = await listExecutions({
    taskId: url.searchParams.get('taskId') ?? undefined,
    agentId: url.searchParams.get('agentId') ?? undefined,
    status: (url.searchParams.get('status') as ExecutionStatus) ?? undefined,
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
  const body = (await req.json()) as {
    taskId: string;
    agentId: string;
    capabilityId: string;
    args?: Record<string, unknown>;
    cliFlags?: Record<string, string | boolean>;
    parentExecutionId?: string;
    sessionRef?: string;
    promptOverride?: string;
  };

  // Check if the capability uses prompt mode (required for session path)
  let isPromptMode = false;
  if (config.USE_SESSION_PROCESS) {
    const [cap] = await db
      .select({ interactionMode: agentCapabilities.interactionMode })
      .from(agentCapabilities)
      .where(eq(agentCapabilities.id, body.capabilityId))
      .limit(1);
    isPromptMode = cap?.interactionMode === 'prompt';
  }

  if (config.USE_SESSION_PROCESS && isPromptMode) {
    // Session path: create session first, then execution
    const session = await createSession({
      taskId: body.taskId,
      agentId: body.agentId,
      capabilityId: body.capabilityId,
    });

    const execution = await createExecution({
      ...body,
      sessionId: session.id,
    });

    await enqueueExecution({
      executionId: execution.id,
      capabilityId: execution.capabilityId,
      agentId: execution.agentId,
      args: execution.args,
      sessionId: session.id,
    });

    return NextResponse.json({ data: { ...execution, sessionId: session.id } }, { status: 201 });
  }

  // Legacy path: no session
  const execution = await createExecution(body);

  await enqueueExecution({
    executionId: execution.id,
    capabilityId: execution.capabilityId,
    agentId: execution.agentId,
    args: execution.args,
  });

  return NextResponse.json({ data: execution }, { status: 201 });
});

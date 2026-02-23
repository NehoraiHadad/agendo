import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { format } from 'date-fns';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getProject } from '@/lib/services/project-service';
import { createTask } from '@/lib/services/task-service';
import { createSession } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import { BadRequestError } from '@/lib/errors';
import { db } from '@/lib/db';
import { agentCapabilities } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

const quickLaunchSchema = z.object({
  agentId: z.string().uuid(),
  initialPrompt: z.string().optional(),
  view: z.enum(['chat', 'terminal']).optional().default('chat'),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');

    const body = quickLaunchSchema.parse(await req.json());

    // Validate project exists
    await getProject(id);

    // Find prompt-mode capability for the agent
    const [cap] = await db
      .select({ id: agentCapabilities.id })
      .from(agentCapabilities)
      .where(
        and(
          eq(agentCapabilities.agentId, body.agentId),
          eq(agentCapabilities.interactionMode, 'prompt'),
          eq(agentCapabilities.isEnabled, true),
        ),
      )
      .limit(1);

    if (!cap) {
      throw new BadRequestError('Agent has no prompt-mode capability');
    }

    // Create scratch task
    const task = await createTask({
      title: `Ad-hoc · ${format(new Date(), 'MMM d, HH:mm')}`,
      description: 'Auto-created for quick agent launch.',
      projectId: id,
      status: 'in_progress',
      assigneeAgentId: body.agentId,
    });

    // Create and enqueue session
    const session = await createSession({
      taskId: task.id,
      agentId: body.agentId,
      capabilityId: cap.id,
      initialPrompt: body.initialPrompt,
      permissionMode: 'bypassPermissions',
    });

    await enqueueSession({ sessionId: session.id });

    return NextResponse.json({ data: { sessionId: session.id, taskId: task.id } }, { status: 201 });
  },
);

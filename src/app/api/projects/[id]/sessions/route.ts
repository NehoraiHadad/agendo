import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getProject } from '@/lib/services/project-service';
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
  kind: z.enum(['conversation', 'execution']).optional().default('conversation'),
  mcpServerIds: z.array(z.string().uuid()).optional(),
  useWorktree: z.boolean().optional(),
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

    if (body.kind === 'conversation') {
      // Conversation mode: create session directly with projectId, no task
      const session = await createSession({
        projectId: id,
        kind: 'conversation',
        agentId: body.agentId,
        capabilityId: cap.id,
        initialPrompt: body.initialPrompt,
        permissionMode: 'bypassPermissions',
        mcpServerIds: body.mcpServerIds,
        useWorktree: body.useWorktree,
      });

      if (body.initialPrompt) {
        await enqueueSession({ sessionId: session.id });
      }

      return NextResponse.json({ data: { sessionId: session.id } }, { status: 201 });
    }

    // Execution mode: session without a task — user links it to a task manually if needed
    const session = await createSession({
      projectId: id,
      kind: 'execution',
      agentId: body.agentId,
      capabilityId: cap.id,
      initialPrompt: body.initialPrompt,
      permissionMode: 'bypassPermissions',
      mcpServerIds: body.mcpServerIds,
      useWorktree: body.useWorktree,
    });

    if (body.initialPrompt) {
      await enqueueSession({ sessionId: session.id });
    }

    return NextResponse.json({ data: { sessionId: session.id } }, { status: 201 });
  },
);

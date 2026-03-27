import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getProject } from '@/lib/services/project-service';
import { createSession } from '@/lib/services/session-service';
import { dispatchSession } from '@/lib/services/session-dispatch';

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

    const session = await createSession({
      projectId: id,
      kind: body.kind,
      agentId: body.agentId,
      initialPrompt: body.initialPrompt,
      permissionMode: 'bypassPermissions',
      mcpServerIds: body.mcpServerIds,
      useWorktree: body.useWorktree,
    });

    if (body.initialPrompt) {
      await dispatchSession({ sessionId: session.id, resumePrompt: body.initialPrompt });
    }

    return NextResponse.json({ data: { sessionId: session.id } }, { status: 201 });
  },
);

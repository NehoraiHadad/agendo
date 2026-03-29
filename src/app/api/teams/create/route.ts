import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTeam } from '@/lib/services/team-creation-service';
import { z } from 'zod';

const createTeamSchema = z.object({
  mode: z.enum(['agent_led', 'ui_led']),
  leadSessionId: z.string().uuid().optional(),
  teamName: z.string().min(1),
  members: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        role: z.string().min(1),
        prompt: z.string().min(1),
        permissionMode: z.enum(['default', 'bypassPermissions', 'acceptEdits']).optional(),
        model: z.string().optional(),
      }),
    )
    .min(1),
  projectId: z.string().uuid(),
  parentTaskId: z.string().uuid(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createTeamSchema.parse(await req.json());
  const result = await createTeam(body);
  return NextResponse.json({ data: result }, { status: 201 });
});

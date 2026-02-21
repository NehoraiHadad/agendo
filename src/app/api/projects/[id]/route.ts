import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getProject, updateProject, deleteProject } from '@/lib/services/project-service';
import { ValidationError } from '@/lib/errors';

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  rootPath: z.string().min(1).optional(),
  envOverrides: z.record(z.string()).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
});

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const project = await getProject(id);
    return NextResponse.json({ data: project });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const body = await req.json();
    const validated = patchSchema.parse(body);

    try {
      const project = await updateProject(id, validated);
      return NextResponse.json({ data: project });
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not exist on disk')) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    await deleteProject(id);
    return new NextResponse(null, { status: 204 });
  },
);

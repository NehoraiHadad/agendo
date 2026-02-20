import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { listProjects, createProject } from '@/lib/services/project-service';
import { ValidationError } from '@/lib/errors';

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  rootPath: z.string().min(1),
  envOverrides: z.record(z.string()).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(50).optional(),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const isActiveParam = url.searchParams.get('isActive');

  let isActive: boolean | undefined;
  if (isActiveParam === 'true') isActive = true;
  else if (isActiveParam === 'false') isActive = false;

  const data = await listProjects(isActive);
  return NextResponse.json({ data });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const validated = createProjectSchema.parse(body);

  try {
    const project = await createProject(validated);
    return NextResponse.json({ data: project }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not exist on disk')) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
});

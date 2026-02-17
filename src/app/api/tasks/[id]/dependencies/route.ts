import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  addDependency,
  removeDependency,
  listDependencies,
} from '@/lib/services/dependency-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const deps = await listDependencies(id);
    return NextResponse.json({ data: deps });
  },
);

const addSchema = z.object({
  dependsOnTaskId: z.string().uuid(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();
    const { dependsOnTaskId } = addSchema.parse(body);
    const dep = await addDependency(id, dependsOnTaskId);
    return NextResponse.json({ data: dep }, { status: 201 });
  },
);

const deleteSchema = z.object({
  dependsOnTaskId: z.string().uuid(),
});

export const DELETE = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();
    const { dependsOnTaskId } = deleteSchema.parse(body);
    await removeDependency(id, dependsOnTaskId);
    return NextResponse.json({ data: null });
  },
);

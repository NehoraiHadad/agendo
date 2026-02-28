import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSnapshot, updateSnapshot, deleteSnapshot } from '@/lib/services/snapshot-service';
import { z } from 'zod';

const keyFindingsSchema = z.object({
  filesExplored: z.array(z.string()),
  findings: z.array(z.string()),
  hypotheses: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

const patchSchema = z.object({
  name: z.string().optional(),
  summary: z.string().optional(),
  keyFindings: keyFindingsSchema.optional(),
});

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'ContextSnapshot');

    const snapshot = await getSnapshot(id);
    return NextResponse.json({ data: snapshot });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'ContextSnapshot');

    const body = patchSchema.parse(await req.json());
    const snapshot = await updateSnapshot(id, body);
    return NextResponse.json({ data: snapshot });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'ContextSnapshot');

    await deleteSnapshot(id);
    return NextResponse.json({ data: { id } });
  },
);

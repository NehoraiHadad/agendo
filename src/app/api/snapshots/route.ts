import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { QueryParams } from '@/lib/query-params';
import { createSnapshot, listSnapshots } from '@/lib/services/snapshot-service';

const createSnapshotSchema = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  name: z.string().min(1).max(500),
  summary: z.string().min(1),
  keyFindings: z
    .object({
      filesExplored: z.array(z.string()).default([]),
      findings: z.array(z.string()).default([]),
      hypotheses: z.array(z.string()).default([]),
      nextSteps: z.array(z.string()).default([]),
    })
    .optional(),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const qp = new QueryParams(req);
  const projectId = qp.getString('projectId');
  const limit = qp.getNumber('limit');

  const data = await listSnapshots({ projectId, limit });
  return NextResponse.json({ data });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createSnapshotSchema.parse(await req.json());
  const snapshot = await createSnapshot(body);
  return NextResponse.json({ data: snapshot }, { status: 201 });
});

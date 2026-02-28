import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { writeConfigFile } from '@/lib/services/config-service';

const writeFileSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
});

export const PUT = withErrorBoundary(async (req: NextRequest) => {
  const body = writeFileSchema.parse(await req.json());
  await writeConfigFile(body.path, body.content);
  return NextResponse.json({ data: { path: body.path } });
});

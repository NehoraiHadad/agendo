import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readFileSync, existsSync } from 'node:fs';
import { NotFoundError } from '@/lib/errors';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const [execution] = await db
      .select({ logFilePath: executions.logFilePath })
      .from(executions)
      .where(eq(executions.id, id))
      .limit(1);
    if (!execution) throw new NotFoundError('Execution', id);
    if (!execution.logFilePath || !existsSync(execution.logFilePath)) {
      return NextResponse.json({ data: { content: '' } });
    }
    const content = readFileSync(execution.logFilePath, 'utf-8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="execution-${id}.log"`,
      },
    });
  },
);

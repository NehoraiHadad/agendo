import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withErrorBoundary } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/errors';

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();
    const { message } = body;
    if (!message || typeof message !== 'string') {
      throw new ValidationError('message is required and must be a string');
    }
    const [execution] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
    if (!execution) throw new NotFoundError('Execution', id);
    if (execution.status !== 'running') {
      throw new ConflictError(
        `Cannot send message to execution in "${execution.status}" status. Must be "running".`,
      );
    }
    const msgDir = join('/tmp', 'agent-monitor-messages', id);
    mkdirSync(msgDir, { recursive: true });
    const msgFile = join(msgDir, `${Date.now()}.msg`);
    writeFileSync(msgFile, message, 'utf-8');
    return NextResponse.json({ data: { sent: true } });
  },
);

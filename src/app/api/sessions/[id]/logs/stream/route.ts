import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogStreamHandler } from '@/lib/api/create-log-stream-handler';

const TERMINAL_STATUSES = new Set(['ended']);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Record<string, string>> },
) {
  const { id } = await params;

  return createLogStreamHandler(req, id, {
    terminalStatuses: TERMINAL_STATUSES,
    notFoundMessage: `Session ${id} not found`,
    async getRecord(sessionId) {
      const [row] = await db
        .select({ logFilePath: sessions.logFilePath, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
    async pollStatus(sessionId) {
      const [row] = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
  });
}

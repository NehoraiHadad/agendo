import { NextRequest } from 'next/server';
import { createLogStreamHandler } from '@/lib/api/create-log-stream-handler';
import { assertUUID } from '@/lib/api-handler';
import { getSessionLogInfo, getSessionStatus } from '@/lib/services/session-service';

const TERMINAL_STATUSES = new Set(['ended']);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Record<string, string>> },
) {
  const { id } = await params;
  try {
    assertUUID(id, 'Session');
  } catch {
    return new Response('Not found', { status: 404 });
  }

  return createLogStreamHandler(req, id, {
    terminalStatuses: TERMINAL_STATUSES,
    notFoundMessage: `Session ${id} not found`,
    getRecord: getSessionLogInfo,
    pollStatus: getSessionStatus,
  });
}

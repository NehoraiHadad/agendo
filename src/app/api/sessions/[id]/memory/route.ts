import { withErrorBoundary } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { buildMemoryHandlers } from '@/app/api/_shared/memory-handler';

const { GET: getHandler, POST: postHandler } = buildMemoryHandlers(async (id) => {
  const session = await getSession(id);
  return session.agentId;
});

export const GET = withErrorBoundary(getHandler);
export const POST = withErrorBoundary(postHandler);

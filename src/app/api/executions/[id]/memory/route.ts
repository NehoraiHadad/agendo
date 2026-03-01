import { withErrorBoundary } from '@/lib/api-handler';
import { getExecutionById } from '@/lib/services/execution-service';
import { buildMemoryHandlers } from '@/app/api/_shared/memory-handler';

const { GET: getHandler, POST: postHandler } = buildMemoryHandlers(async (id) => {
  const execution = await getExecutionById(id);
  return execution.agentId;
});

export const GET = withErrorBoundary(getHandler);
export const POST = withErrorBoundary(postHandler);

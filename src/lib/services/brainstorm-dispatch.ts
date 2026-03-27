import { sendBrainstormStart } from '@/lib/realtime/worker-client';

/**
 * Dispatch a brainstorm orchestration job to the worker via HTTP.
 * Dispatches via Worker HTTP.
 */
export async function dispatchBrainstorm(roomId: string): Promise<void> {
  const result = await sendBrainstormStart(roomId);
  if (!result.ok) {
    throw new Error(`Failed to dispatch brainstorm ${roomId} to worker`);
  }
}

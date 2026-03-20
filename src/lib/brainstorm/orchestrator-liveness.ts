import { probeBrainstormOrchestrator } from '@/lib/realtime/worker-client';

/**
 * Explicit liveness primitive for brainstorm control routes.
 * Returns true only when the worker confirms a live in-memory control handler.
 */
export async function isBrainstormOrchestratorLive(roomId: string): Promise<boolean> {
  return probeBrainstormOrchestrator(roomId);
}

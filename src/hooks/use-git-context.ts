import type { AgendoEvent, GitContextSnapshot } from '@/lib/realtime/event-types';

export interface GitContextState {
  snapshot: GitContextSnapshot;
  capturedAt: string;
  trigger: 'start' | 'turn_end' | 'exit' | 'reconnect';
}

/**
 * Extracts the latest git context snapshot from session events.
 * Returns null if no system:git-context event has been received.
 */
export function useGitContext(events: AgendoEvent[]): GitContextState | null {
  const gitEvents = events.filter(
    (e): e is Extract<AgendoEvent, { type: 'system:git-context' }> =>
      e.type === 'system:git-context',
  );
  const latest = gitEvents.at(-1);
  if (!latest) return null;
  return {
    snapshot: latest.snapshot,
    capturedAt: latest.capturedAt,
    trigger: latest.trigger,
  };
}

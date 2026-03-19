import { useMemo } from 'react';
import type { AgendoEvent } from '@/lib/realtime/event-types';
import type { ContentionSeverity } from '@/lib/store/contention-store';

export interface ContentionAlert {
  conflictingFiles: string[];
  severity: ContentionSeverity;
  sessions: Array<{
    sessionId: string;
    agentName: string;
    agentSlug: string;
    branch: string;
    taskTitle?: string;
  }>;
}

function extractLatestContention(events: AgendoEvent[]): ContentionAlert | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'system:file-contention') {
      return {
        conflictingFiles: e.conflictingFiles,
        severity: e.severity,
        sessions: e.sessions,
      };
    }
  }
  return null;
}

/**
 * Extracts the latest file contention alert from a stream of events.
 * Returns null when no contention has been detected.
 */
export function useFileContention(events: AgendoEvent[]): ContentionAlert | null {
  return useMemo(() => extractLatestContention(events), [events]);
}

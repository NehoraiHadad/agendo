import type { AgendoEvent } from '@/lib/realtime/events';

export interface ContextStats {
  inputTokens: number;
  contextWindow: number | null;
}

/** Return token stats from the most recent agent:result event, or null if none yet. */
export function getLatestContextStats(events: AgendoEvent[]): ContextStats | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'agent:result' && e.modelUsage) {
      let inputTokens = 0;
      let contextWindow: number | null = null;
      for (const usage of Object.values(e.modelUsage)) {
        inputTokens += usage.inputTokens;
        if (usage.contextWindow) contextWindow = usage.contextWindow;
      }
      if (inputTokens > 0) return { inputTokens, contextWindow };
    }
  }
  return null;
}

/** Format a token count as a compact string: 1500 → "2K", 1_200_000 → "1.2M" */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

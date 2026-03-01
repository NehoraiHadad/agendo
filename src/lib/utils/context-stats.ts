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

/** Format a fill percentage. Shows "<1%" instead of "0%" for tiny-but-nonzero values. */
export function fmtPct(ratio: number): string {
  const rounded = Math.round(ratio * 100);
  if (ratio > 0 && rounded === 0) return '<1%';
  return `${rounded}%`;
}

/** CSS width value for a context bar — guarantees a minimum visible width of 3px. */
export function ctxBarWidth(ratio: number): string {
  const pct = Math.min(100, ratio * 100);
  return `max(3px, ${pct}%)`;
}

/** Bar fill color based on fill ratio. */
export function ctxBarColor(ratio: number): string {
  if (ratio > 0.8) return 'oklch(0.65 0.22 25)';
  if (ratio > 0.6) return 'oklch(0.72 0.18 60)';
  return 'oklch(0.65 0.18 280)';
}

/** Faint track background — same hue as the fill so the bar always looks colored. */
export function ctxTrackColor(ratio: number): string {
  if (ratio > 0.8) return 'oklch(0.65 0.22 25 / 0.18)';
  if (ratio > 0.6) return 'oklch(0.72 0.18 60 / 0.18)';
  return 'oklch(0.65 0.18 280 / 0.18)';
}

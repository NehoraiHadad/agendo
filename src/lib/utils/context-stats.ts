import type { AgendoEvent } from '@/lib/realtime/events';

export interface ContextStats {
  inputTokens: number;
  contextWindow: number | null;
}

/**
 * Return token stats from the most recent relevant event, or null if none yet.
 *
 * Priority (most-recent-first scan):
 * 1. `agent:usage` — emitted at message_start time (start of each API call). Gives real-time
 *    updates during an active turn, before agent:result fires.
 * 2. `agent:result` with `perCallContextStats` — attached after each turn completes. More
 *    accurate than modelUsage because it represents a single API call, not an aggregation.
 * 3. `agent:result` with `modelUsage` fallback — aggregated across all API calls in the turn.
 *    For turns with many tool calls (e.g. 10 tool calls × 150K cache each = 1.5M aggregated),
 *    this far exceeds the context window. We cap it at contextWindow so the bar shows 100%.
 */
export function getLatestContextStats(events: AgendoEvent[]): ContextStats | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];

    // agent:usage — real-time during active streaming (message_start fires mid-turn)
    if (e.type === 'agent:usage' && e.size > 0) {
      return { inputTokens: e.used, contextWindow: e.size };
    }

    if (e.type === 'agent:result' && e.modelUsage) {
      // Extract contextWindow from modelUsage (it's the same across all model entries).
      let contextWindow: number | null = null;
      for (const usage of Object.values(e.modelUsage)) {
        if (usage.contextWindow) contextWindow = usage.contextWindow;
      }

      // Prefer per-call stats: these come from message_start and represent a single
      // API call, so cache_read + cache_create + input = actual context tokens used.
      if (e.perCallContextStats) {
        const { inputTokens, cacheReadInputTokens, cacheCreationInputTokens } =
          e.perCallContextStats;
        const total = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
        if (total > 0) return { inputTokens: total, contextWindow };
      }

      // Fallback: sum all input+cache tokens from modelUsage, but cap at contextWindow.
      // Without capping, complex turns (N API calls) report N× the context window.
      let rawTotal = 0;
      for (const usage of Object.values(e.modelUsage)) {
        rawTotal +=
          usage.inputTokens +
          (usage.cacheReadInputTokens ?? 0) +
          (usage.cacheCreationInputTokens ?? 0);
      }
      const inputTokens = contextWindow ? Math.min(rawTotal, contextWindow) : rawTotal;
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

/**
 * Brainstorm Telemetry — privacy-safe anonymous statistics collection.
 *
 * Collects numeric/enum-only data from completed brainstorm sessions.
 * No topic content, agent responses, user identity, or project names are included.
 *
 * Data flow:
 * 1. Always: appended to local JSONL file (LOG_DIR/brainstorm-telemetry.jsonl)
 * 2. Opt-in: emitted as SSE event for frontend to show confirmation dialog
 *    before sending to GitHub Issues (TELEMETRY_GITHUB_REPO env var)
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { WaveQualityScore } from '@/lib/worker/brainstorm-quality';
import type { BrainstormOutcome } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('brainstorm-telemetry');

// ============================================================================
// Types
// ============================================================================

export interface BrainstormTelemetryReport {
  /** Schema version for forward compatibility */
  v: 1;
  /** ISO timestamp of report generation */
  ts: string;
  /** Agendo version */
  agendoVersion: string;

  // --- Outcome (from BrainstormOutcome) ---
  endState: BrainstormOutcome['endState'];
  totalWaves: number;
  totalParticipants: number;
  activeParticipantsAtEnd: number;
  evictedCount: number;
  timeoutCount: number;
  convergenceWave: number | null;
  reflectionWavesTriggered: number;
  totalDurationSec: number;
  synthesisParseSuccess: boolean;
  taskCreationCount: number;
  deliverableType: string | null;

  // --- Config (enum/number only, no free text) ---
  convergenceMode: string;
  synthesisMode: string;
  waveTimeoutSec: number;
  minWavesBeforePass: number;
  maxWaves: number;
  reactiveInjection: boolean;
  autoReflection: boolean;
  reviewPauseSec: number;
  presetId: string | null;

  // --- Agent composition (slugs only, no IDs) ---
  agentSlugs: string[];
  /** Whether duplicate agents were used in this room */
  hasDuplicateAgents: boolean;

  // --- Quality signals (aggregate) ---
  avgRepeatRatio: number;
  avgNoveltyPerWave: number;
  avgAgreementRatio: number;
  peakRepeatRatio: number;

  // --- User engagement ---
  feedbackCount: { thumbsUp: number; thumbsDown: number; focus: number };
}

// ============================================================================
// Report builder
// ============================================================================

export interface TelemetryInput {
  outcome: BrainstormOutcome;
  waveQualityScores: WaveQualityScore[];
  feedbackMap: Map<number, Array<{ signal: 'thumbs_up' | 'thumbs_down' | 'focus' }>>;
  participants: Array<{ agentSlug: string; agentId: string }>;
  config: {
    convergenceMode: string;
    synthesisMode: string;
    waveTimeoutSec: number;
    minWavesBeforePass: number;
    reactiveInjection: boolean;
    autoReflection: boolean;
    reviewPauseSec: number;
  };
  maxWaves: number;
  presetId: string | null;
}

/**
 * Build an anonymous telemetry report from orchestrator state.
 * Contains only numeric values, enums, and agent slugs — no content.
 */
export function buildTelemetryReport(input: TelemetryInput): BrainstormTelemetryReport {
  const { outcome, waveQualityScores, feedbackMap, participants, config } = input;

  // Agent composition
  const slugs = participants.map((p) => p.agentSlug);
  const uniqueAgentIds = new Set(participants.map((p) => p.agentId));
  const hasDuplicateAgents = uniqueAgentIds.size < participants.length;

  // Quality aggregates
  const scores = waveQualityScores;
  const avgRepeatRatio =
    scores.length > 0 ? scores.reduce((s, q) => s + q.repeatRatio, 0) / scores.length : 0;
  const avgNoveltyPerWave =
    scores.length > 0 ? scores.reduce((s, q) => s + q.newIdeasCount, 0) / scores.length : 0;
  const avgAgreementRatio =
    scores.length > 0 ? scores.reduce((s, q) => s + q.agreementRatio, 0) / scores.length : 0;
  const peakRepeatRatio = scores.length > 0 ? Math.max(...scores.map((q) => q.repeatRatio)) : 0;

  // Feedback counts
  const feedbackCount = { thumbsUp: 0, thumbsDown: 0, focus: 0 };
  for (const entries of feedbackMap.values()) {
    for (const f of entries) {
      if (f.signal === 'thumbs_up') feedbackCount.thumbsUp++;
      else if (f.signal === 'thumbs_down') feedbackCount.thumbsDown++;
      else if (f.signal === 'focus') feedbackCount.focus++;
    }
  }

  // Read version from package.json (best-effort)
  let agendoVersion = 'unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json') as { version?: string };
    agendoVersion = pkg.version ?? 'unknown';
  } catch {
    // Ignore — bundled worker may not resolve package.json
  }

  return {
    v: 1,
    ts: new Date().toISOString(),
    agendoVersion,

    endState: outcome.endState,
    totalWaves: outcome.totalWaves,
    totalParticipants: outcome.totalParticipants,
    activeParticipantsAtEnd: outcome.activeParticipantsAtEnd,
    evictedCount: outcome.evictedCount,
    timeoutCount: outcome.timeoutCount,
    convergenceWave: outcome.convergenceWave,
    reflectionWavesTriggered: outcome.reflectionWavesTriggered,
    totalDurationSec: Math.round(outcome.totalDurationMs / 1000),
    synthesisParseSuccess: outcome.synthesisParseSuccess,
    taskCreationCount: outcome.taskCreationCount,
    deliverableType: outcome.deliverableType,

    convergenceMode: config.convergenceMode,
    synthesisMode: config.synthesisMode,
    waveTimeoutSec: config.waveTimeoutSec,
    minWavesBeforePass: config.minWavesBeforePass,
    maxWaves: input.maxWaves,
    reactiveInjection: config.reactiveInjection,
    autoReflection: config.autoReflection,
    reviewPauseSec: config.reviewPauseSec,
    presetId: input.presetId,

    agentSlugs: slugs,
    hasDuplicateAgents,

    avgRepeatRatio: round2(avgRepeatRatio),
    avgNoveltyPerWave: round2(avgNoveltyPerWave),
    avgAgreementRatio: round2(avgAgreementRatio),
    peakRepeatRatio: round2(peakRepeatRatio),

    feedbackCount,
  };
}

// ============================================================================
// Local JSONL writer
// ============================================================================

/**
 * Append a telemetry report to the local JSONL log file.
 * Creates the file and parent directories if they don't exist.
 */
export function appendToLocalLog(report: BrainstormTelemetryReport, logDir: string): void {
  try {
    const filePath = `${logDir}/brainstorm-telemetry.jsonl`;
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(report) + '\n');
    log.info({ filePath }, 'Telemetry report written to local log');
  } catch (err) {
    log.warn({ err }, 'Failed to write telemetry report to local log');
  }
}

// ============================================================================
// GitHub Issue formatter
// ============================================================================

/**
 * Format a telemetry report as a GitHub Issue body.
 * Uses markdown for readability.
 */
export function formatAsGitHubIssue(report: BrainstormTelemetryReport): {
  title: string;
  body: string;
  labels: string[];
} {
  const endEmoji =
    report.endState === 'converged'
      ? '✅'
      : report.endState === 'stalled'
        ? '⏸️'
        : report.endState === 'max_waves'
          ? '🔄'
          : '⏹️';

  const title = `[telemetry] ${endEmoji} ${report.endState} — ${report.totalWaves} waves, ${report.totalParticipants} participants`;

  const body = `## Session Summary
- **End state**: ${report.endState}
- **Waves**: ${report.totalWaves}${report.convergenceWave !== null ? ` (converged at wave ${report.convergenceWave})` : ''}
- **Max waves**: ${report.maxWaves}
- **Participants**: ${report.totalParticipants} (${report.activeParticipantsAtEnd} active at end)
- **Duration**: ${report.totalDurationSec}s
- **Agents**: ${report.agentSlugs.join(', ')}${report.hasDuplicateAgents ? ' *(includes duplicates)*' : ''}

## Config
- **Preset**: ${report.presetId ?? 'custom'}
- **Convergence**: ${report.convergenceMode}
- **Synthesis**: ${report.synthesisMode}
- **Wave timeout**: ${report.waveTimeoutSec}s
- **Min waves before pass**: ${report.minWavesBeforePass}
- **Reactive injection**: ${report.reactiveInjection ? 'yes' : 'no'}
- **Auto-reflection**: ${report.autoReflection ? 'yes' : 'no'}
- **Review pause**: ${report.reviewPauseSec}s

## Quality Signals
- **Avg repeat ratio**: ${(report.avgRepeatRatio * 100).toFixed(0)}%
- **Peak repeat ratio**: ${(report.peakRepeatRatio * 100).toFixed(0)}%
- **Avg novelty/wave**: ${report.avgNoveltyPerWave.toFixed(1)} new ideas
- **Avg agreement**: ${(report.avgAgreementRatio * 100).toFixed(0)}%
- **Reflections triggered**: ${report.reflectionWavesTriggered}

## Outcomes
- **Synthesis parsed**: ${report.synthesisParseSuccess ? 'yes' : 'no'}
- **Tasks created**: ${report.taskCreationCount}
- **Evictions**: ${report.evictedCount}
- **Timeouts**: ${report.timeoutCount}

## User Feedback
- 👍 ${report.feedbackCount.thumbsUp}  👎 ${report.feedbackCount.thumbsDown}  🎯 ${report.feedbackCount.focus}

---
*agendo v${report.agendoVersion} • ${report.ts}*
*This report contains only anonymous statistics. No topic content, responses, or personal data is included.*`;

  return {
    title,
    body,
    labels: ['telemetry', `end:${report.endState}`],
  };
}

// ============================================================================
// Helpers
// ============================================================================

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

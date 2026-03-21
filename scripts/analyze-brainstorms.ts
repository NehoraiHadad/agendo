#!/usr/bin/env tsx
/**
 * Brainstorm analysis script — correlates outcomes with room configuration.
 *
 * Usage:
 *   npx tsx scripts/analyze-brainstorms.ts          # terminal report
 *   npx tsx scripts/analyze-brainstorms.ts --json    # JSON output
 *   pnpm analyze:brainstorms                         # via package.json
 */

import { db, pool } from '../src/lib/db';
import { brainstormRooms } from '../src/lib/db/schema';
import type { BrainstormOutcome, BrainstormConfig } from '../src/lib/db/schema';
import { desc } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoomRow {
  id: string;
  title: string;
  status: string;
  currentWave: number;
  maxWaves: number;
  config: BrainstormConfig;
  outcome: BrainstormOutcome | null;
  createdAt: Date;
}

interface DeliverableStats {
  count: number;
  avgWaves: number;
  avgDurationMs: number;
  convergedCount: number;
  timeoutTotal: number;
  taskCreationTotal: number;
}

interface Report {
  summary: {
    totalRooms: number;
    byStatus: Record<string, number>;
    withOutcome: number;
    withoutOutcome: number;
  };
  byDeliverableType: Record<string, DeliverableStats>;
  endStateDistribution: Record<string, number>;
  configCompleteness: {
    withGoal: number;
    withConstraints: number;
    withDeliverableType: number;
    withRoles: number;
    withLanguage: number;
    total: number;
  };
  timeoutPatterns: Array<{
    id: string;
    title: string;
    timeoutCount: number;
    totalWaves: number;
    evictedCount: number;
    endState: string;
  }>;
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function hasOutcomeColumn(): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'brainstorm_rooms' AND column_name = 'outcome'
     LIMIT 1`,
  );
  return result.rows.length > 0;
}

async function loadRooms(): Promise<RoomRow[]> {
  const outcomeExists = await hasOutcomeColumn();

  if (outcomeExists) {
    return db
      .select({
        id: brainstormRooms.id,
        title: brainstormRooms.title,
        status: brainstormRooms.status,
        currentWave: brainstormRooms.currentWave,
        maxWaves: brainstormRooms.maxWaves,
        config: brainstormRooms.config,
        outcome: brainstormRooms.outcome,
        createdAt: brainstormRooms.createdAt,
      })
      .from(brainstormRooms)
      .orderBy(desc(brainstormRooms.createdAt));
  }

  // Fallback: outcome column not yet added to DB
  const rows = await db
    .select({
      id: brainstormRooms.id,
      title: brainstormRooms.title,
      status: brainstormRooms.status,
      currentWave: brainstormRooms.currentWave,
      maxWaves: brainstormRooms.maxWaves,
      config: brainstormRooms.config,
      createdAt: brainstormRooms.createdAt,
    })
    .from(brainstormRooms)
    .orderBy(desc(brainstormRooms.createdAt));

  return rows.map((r) => ({ ...r, outcome: null }));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyze(rooms: RoomRow[]): Report {
  const withOutcome = rooms.filter((r) => r.outcome != null);
  const outcomes = withOutcome.map((r) => r.outcome!);

  // Summary
  const byStatus: Record<string, number> = {};
  for (const r of rooms) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  // End state distribution
  const endStateDistribution: Record<string, number> = {};
  for (const o of outcomes) {
    endStateDistribution[o.endState] = (endStateDistribution[o.endState] ?? 0) + 1;
  }

  // By deliverable type
  const byDeliverable: Record<string, DeliverableStats> = {};
  for (const r of withOutcome) {
    const o = r.outcome!;
    const key = o.deliverableType ?? '(unset)';
    if (!byDeliverable[key]) {
      byDeliverable[key] = {
        count: 0,
        avgWaves: 0,
        avgDurationMs: 0,
        convergedCount: 0,
        timeoutTotal: 0,
        taskCreationTotal: 0,
      };
    }
    const s = byDeliverable[key];
    s.count++;
    s.avgWaves += o.totalWaves;
    s.avgDurationMs += o.totalDurationMs;
    if (o.endState === 'converged') s.convergedCount++;
    s.timeoutTotal += o.timeoutCount;
    s.taskCreationTotal += o.taskCreationCount;
  }
  // Compute averages
  for (const s of Object.values(byDeliverable)) {
    if (s.count > 0) {
      s.avgWaves = Math.round((s.avgWaves / s.count) * 10) / 10;
      s.avgDurationMs = Math.round(s.avgDurationMs / s.count);
    }
  }

  // Config completeness (all rooms)
  const configCompleteness = {
    withGoal: 0,
    withConstraints: 0,
    withDeliverableType: 0,
    withRoles: 0,
    withLanguage: 0,
    total: rooms.length,
  };
  for (const r of rooms) {
    const c = r.config;
    if (c.goal) configCompleteness.withGoal++;
    if (c.constraints && c.constraints.length > 0) configCompleteness.withConstraints++;
    if (c.deliverableType) configCompleteness.withDeliverableType++;
    if (c.roles && Object.keys(c.roles).length > 0) configCompleteness.withRoles++;
    if (c.language) configCompleteness.withLanguage++;
  }

  // Timeout patterns (rooms with timeouts, sorted by count desc)
  const timeoutPatterns = withOutcome
    .filter((r) => r.outcome!.timeoutCount > 0)
    .map((r) => ({
      id: r.id,
      title: r.title,
      timeoutCount: r.outcome!.timeoutCount,
      totalWaves: r.outcome!.totalWaves,
      evictedCount: r.outcome!.evictedCount,
      endState: r.outcome!.endState,
    }))
    .sort((a, b) => b.timeoutCount - a.timeoutCount);

  // Recommendations
  const recommendations = generateRecommendations(
    rooms,
    withOutcome,
    outcomes,
    endStateDistribution,
  );

  return {
    summary: {
      totalRooms: rooms.length,
      byStatus,
      withOutcome: withOutcome.length,
      withoutOutcome: rooms.length - withOutcome.length,
    },
    byDeliverableType: byDeliverable,
    endStateDistribution,
    configCompleteness,
    timeoutPatterns,
    recommendations,
  };
}

function generateRecommendations(
  rooms: RoomRow[],
  withOutcome: RoomRow[],
  outcomes: BrainstormOutcome[],
  endStates: Record<string, number>,
): string[] {
  const recs: string[] = [];
  if (outcomes.length === 0) {
    recs.push('No outcome data yet. Run some brainstorms to generate analysis data.');
    return recs;
  }

  const total = outcomes.length;

  // Max waves hit rate
  const maxWavesCount = endStates['max_waves'] ?? 0;
  if (maxWavesCount > 0) {
    const pct = Math.round((maxWavesCount / total) * 100);
    recs.push(
      `${pct}% of rooms (${maxWavesCount}/${total}) hit max_waves without convergence — consider raising maxWaves or lowering minWavesBeforePass.`,
    );
  }

  // Stall rate
  const stalledCount = endStates['stalled'] ?? 0;
  if (stalledCount > 0) {
    const pct = Math.round((stalledCount / total) * 100);
    recs.push(
      `${pct}% of rooms (${stalledCount}/${total}) stalled — consider enabling autoReflection or lowering evictionThreshold.`,
    );
  }

  // Error rate
  const errorCount = endStates['error'] ?? 0;
  if (errorCount > 0) {
    recs.push(
      `${errorCount} room(s) ended with errors — check logs for infrastructure or agent issues.`,
    );
  }

  // Timeout correlation
  const highTimeoutRooms = withOutcome.filter((r) => r.outcome!.timeoutCount >= 3);
  if (highTimeoutRooms.length > 0) {
    recs.push(
      `${highTimeoutRooms.length} room(s) had 3+ timeouts — consider increasing waveTimeoutSec or checking agent responsiveness.`,
    );
  }

  // Eviction rate
  const totalEvicted = outcomes.reduce((sum, o) => sum + o.evictedCount, 0);
  const totalParticipants = outcomes.reduce((sum, o) => sum + o.totalParticipants, 0);
  if (totalParticipants > 0 && totalEvicted > 0) {
    const pct = Math.round((totalEvicted / totalParticipants) * 100);
    recs.push(
      `${pct}% of participants (${totalEvicted}/${totalParticipants}) were evicted — ${pct > 20 ? 'this is high, consider raising evictionThreshold' : 'within normal range'}.`,
    );
  }

  // Synthesis success rate
  const synthFail = outcomes.filter((o) => !o.synthesisParseSuccess).length;
  if (synthFail > 0) {
    recs.push(
      `${synthFail} room(s) had synthesis parse failures — check synthesis agent output format.`,
    );
  }

  // Config completeness
  const noGoal = rooms.filter((r) => !r.config.goal).length;
  if (noGoal > 0 && rooms.length > 1) {
    const pct = Math.round((noGoal / rooms.length) * 100);
    recs.push(`${pct}% of rooms have no goal set — setting a goal improves convergence quality.`);
  }

  // Convergence rate
  const convergedCount = endStates['converged'] ?? 0;
  if (convergedCount > 0) {
    const pct = Math.round((convergedCount / total) * 100);
    recs.push(`Convergence rate: ${pct}% (${convergedCount}/${total}).`);
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str;
}

function separator(len: number): string {
  return '-'.repeat(len);
}

function printReport(report: Report): void {
  console.log('\n=== Brainstorm Analysis Report ===\n');

  // --- Summary ---
  console.log('## Summary\n');
  console.log(`  Total rooms:      ${report.summary.totalRooms}`);
  console.log(`  With outcome:     ${report.summary.withOutcome}`);
  console.log(`  Without outcome:  ${report.summary.withoutOutcome}`);
  console.log(`\n  By status:`);
  for (const [status, count] of Object.entries(report.summary.byStatus)) {
    console.log(`    ${pad(status, 14)} ${count}`);
  }

  // --- End State Distribution ---
  if (Object.keys(report.endStateDistribution).length > 0) {
    console.log('\n## End State Distribution\n');
    const header = `  ${pad('End State', 14)} ${padLeft('Count', 6)} ${padLeft('%', 6)}`;
    console.log(header);
    console.log(`  ${separator(26)}`);
    const total = Object.values(report.endStateDistribution).reduce((a, b) => a + b, 0);
    for (const [state, count] of Object.entries(report.endStateDistribution)) {
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      console.log(`  ${pad(state, 14)} ${padLeft(String(count), 6)} ${padLeft(pct + '%', 6)}`);
    }
  }

  // --- By Deliverable Type ---
  if (Object.keys(report.byDeliverableType).length > 0) {
    console.log('\n## By Deliverable Type\n');
    const header = `  ${pad('Type', 18)} ${padLeft('Count', 6)} ${padLeft('AvgWv', 6)} ${padLeft('AvgDur', 8)} ${padLeft('Conv%', 6)} ${padLeft('Tasks', 6)}`;
    console.log(header);
    console.log(`  ${separator(50)}`);
    for (const [type, s] of Object.entries(report.byDeliverableType)) {
      const convPct = s.count > 0 ? Math.round((s.convergedCount / s.count) * 100) : 0;
      console.log(
        `  ${pad(type, 18)} ${padLeft(String(s.count), 6)} ${padLeft(String(s.avgWaves), 6)} ${padLeft(formatDuration(s.avgDurationMs), 8)} ${padLeft(convPct + '%', 6)} ${padLeft(String(s.taskCreationTotal), 6)}`,
      );
    }
  }

  // --- Config Completeness ---
  console.log('\n## Config Completeness\n');
  const cc = report.configCompleteness;
  if (cc.total === 0) {
    console.log('  No rooms to analyze.');
  } else {
    const fields: Array<[string, number]> = [
      ['Goal', cc.withGoal],
      ['Constraints', cc.withConstraints],
      ['Deliverable Type', cc.withDeliverableType],
      ['Roles', cc.withRoles],
      ['Language', cc.withLanguage],
    ];
    for (const [label, count] of fields) {
      const pct = Math.round((count / cc.total) * 100);
      console.log(`  ${pad(label, 18)} ${padLeft(String(count), 4)}/${cc.total}  (${pct}%)`);
    }
  }

  // --- Timeout Patterns ---
  if (report.timeoutPatterns.length > 0) {
    console.log('\n## Timeout Patterns\n');
    const header = `  ${pad('Title', 30)} ${padLeft('TOs', 5)} ${padLeft('Waves', 6)} ${padLeft('Evict', 6)} ${pad('End State', 12)}`;
    console.log(header);
    console.log(`  ${separator(59)}`);
    for (const t of report.timeoutPatterns.slice(0, 10)) {
      console.log(
        `  ${pad(t.title.slice(0, 30), 30)} ${padLeft(String(t.timeoutCount), 5)} ${padLeft(String(t.totalWaves), 6)} ${padLeft(String(t.evictedCount), 6)} ${pad(t.endState, 12)}`,
      );
    }
    if (report.timeoutPatterns.length > 10) {
      console.log(`  ... and ${report.timeoutPatterns.length - 10} more`);
    }
  }

  // --- Recommendations ---
  if (report.recommendations.length > 0) {
    console.log('\n## Recommendations\n');
    for (const rec of report.recommendations) {
      console.log(`  * ${rec}`);
    }
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const jsonMode = process.argv.includes('--json');

  const rooms = await loadRooms();
  const report = analyze(rooms);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (rooms.length === 0) {
      console.log('\nNo brainstorm rooms found. Nothing to analyze.\n');
    } else {
      printReport(report);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});

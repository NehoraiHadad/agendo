/**
 * Demo-mode shadow for artifact-service.ts.
 *
 * All exported functions mirror the real service's signatures exactly, but
 * operate entirely on in-memory fixtures — no database access.
 *
 * Mutations return plausible stubs (createArtifact synthesises a new row with
 * a fresh UUID). Nothing is persisted.
 *
 * Imported only via dynamic `await import('./artifact-service.demo')` in demo
 * mode so it is tree-shaken from production bundles.
 */

import { randomUUID } from 'crypto';
import type { artifacts } from '@/lib/db/schema';
import type { InferSelectModel } from 'drizzle-orm';

type Artifact = InferSelectModel<typeof artifacts>;

// ============================================================================
// Canonical shared IDs (must match across all Phase-1 agents)
// ============================================================================

const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';

// Fixed reference point for deterministic timestamps
const NOW = new Date('2026-04-23T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// ============================================================================
// Fixture data — 3 artifacts rendered by the Claude session
// ============================================================================

export const DEMO_ARTIFACTS: readonly Artifact[] = [
  {
    id: 'bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb',
    sessionId: CLAUDE_SESSION_ID,
    planId: null,
    title: 'Sprint Velocity Chart',
    type: 'svg',
    content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160">
  <rect width="320" height="160" fill="#0f172a" rx="8"/>
  <text x="16" y="24" font-family="monospace" font-size="11" fill="#94a3b8">Sprint Velocity (pts)</text>
  <polyline points="20,130 80,100 140,110 200,70 260,50 300,40"
    fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="20" cy="130" r="4" fill="#6366f1"/>
  <circle cx="80" cy="100" r="4" fill="#6366f1"/>
  <circle cx="140" cy="110" r="4" fill="#6366f1"/>
  <circle cx="200" cy="70" r="4" fill="#6366f1"/>
  <circle cx="260" cy="50" r="4" fill="#6366f1"/>
  <circle cx="300" cy="40" r="4" fill="#a5b4fc"/>
  <line x1="20" y1="140" x2="310" y2="140" stroke="#334155" stroke-width="1"/>
</svg>`,
    createdAt: hoursAgo(48),
  },
  {
    id: 'bbbbbbbb-bbbb-4002-b002-bbbbbbbbbbbb',
    sessionId: CLAUDE_SESSION_ID,
    planId: null,
    title: 'Task Status Summary',
    type: 'html',
    content: `<div style="font-family:system-ui;padding:16px;background:#0f172a;color:#e2e8f0;border-radius:8px;max-width:340px">
  <h3 style="margin:0 0 12px;font-size:14px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em">Task Status</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td style="padding:4px 0;color:#a5b4fc">Done</td><td style="text-align:right;font-weight:600;color:#4ade80">4</td></tr>
    <tr><td style="padding:4px 0;color:#a5b4fc">In Progress</td><td style="text-align:right;font-weight:600;color:#facc15">3</td></tr>
    <tr><td style="padding:4px 0;color:#a5b4fc">Blocked</td><td style="text-align:right;font-weight:600;color:#f87171">2</td></tr>
    <tr><td style="padding:4px 0;color:#a5b4fc">Todo</td><td style="text-align:right;font-weight:600;color:#94a3b8">6</td></tr>
  </table>
</div>`,
    createdAt: hoursAgo(24),
  },
  {
    id: 'bbbbbbbb-bbbb-4003-b003-bbbbbbbbbbbb',
    sessionId: CLAUDE_SESSION_ID,
    planId: null,
    title: 'Architecture Decision Record',
    type: 'html',
    content: `<div style="font-family:system-ui;padding:16px;background:#0f172a;color:#e2e8f0;border-radius:8px;max-width:420px;line-height:1.5">
  <h3 style="margin:0 0 8px;font-size:14px;color:#6366f1">ADR-001: Use pg-boss for job queuing</h3>
  <p style="margin:0 0 8px;font-size:13px;color:#94a3b8"><strong style="color:#e2e8f0">Status:</strong> Accepted</p>
  <p style="margin:0 0 8px;font-size:13px;color:#cbd5e1">PostgreSQL-native queue avoids an extra dependency. pg-boss v10 provides durable job storage, scheduling, and at-least-once delivery on top of our existing Postgres instance.</p>
  <p style="margin:0;font-size:12px;color:#64748b">Consequences: worker must run in same Postgres context; job schema managed by pg-boss migrations.</p>
</div>`,
    createdAt: hoursAgo(2),
  },
] satisfies readonly Artifact[];

// ============================================================================
// Shadow exports — must match artifact-service.ts signatures exactly
// ============================================================================

export async function createArtifact(params: {
  sessionId?: string | null;
  planId?: string | null;
  title: string;
  type: 'html' | 'svg';
  content: string;
}): Promise<Artifact> {
  const now = new Date();
  return {
    id: randomUUID(),
    sessionId: params.sessionId ?? null,
    planId: params.planId ?? null,
    title: params.title,
    type: params.type,
    content: params.content,
    createdAt: now,
  };
}

export async function getArtifact(id: string): Promise<Artifact | null> {
  return DEMO_ARTIFACTS.find((a) => a.id === id) ?? null;
}

export async function listArtifactsBySession(sessionId: string): Promise<Artifact[]> {
  return DEMO_ARTIFACTS.filter((a) => a.sessionId === sessionId).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

export async function listArtifactsByPlan(planId: string): Promise<Artifact[]> {
  return DEMO_ARTIFACTS.filter((a) => a.planId === planId).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/**
 * Demo-mode shadow for session-fork-service.
 *
 * Returns a synthesized forked-session row without touching the database,
 * spawning processes, or extracting session context.
 */

import { randomUUID } from 'node:crypto';
import type { ForkToAgentInput, ForkToAgentResult } from './session-fork-service';
import type { Session } from '@/lib/types';

// Canonical demo agent names by UUID (matches agent-service.demo.ts fixtures)
const DEMO_AGENT_NAMES: Record<string, string> = {
  '11111111-1111-4111-a111-111111111111': 'Claude Code',
  '22222222-2222-4222-a222-222222222222': 'Codex CLI',
  '33333333-3333-4333-a333-333333333333': 'Gemini CLI',
};

export async function forkSessionToAgent(input: ForkToAgentInput): Promise<ForkToAgentResult> {
  const now = new Date('2026-04-23T10:00:00.000Z');

  const forkedSession: Session = {
    id: randomUUID(),
    taskId: null,
    projectId: '44444444-4444-4444-a444-444444444444',
    kind: 'conversation',
    agentId: input.newAgentId,
    status: 'idle',
    pid: null,
    workerId: null,
    sessionRef: null,
    eventSeq: 0,
    heartbeatAt: null,
    startedAt: null,
    lastActiveAt: null,
    idleTimeoutSec: 600,
    endedAt: null,
    logFilePath: null,
    totalCostUsd: null,
    totalTurns: 0,
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    initialPrompt: 'Forked session (demo)',
    title: null,
    model: null,
    effort: null,
    webSearchRequests: 0,
    webFetchRequests: 0,
    planFilePath: null,
    autoResumeCount: 0,
    totalDurationMs: null,
    tmuxSessionName: null,
    parentSessionId: input.parentSessionId,
    forkSourceRef: null,
    forkPointUuid: null,
    mcpServerIds: null,
    delegationPolicy: 'suggest',
    teamRole: null,
    useWorktree: false,
    maxBudgetUsd: null,
    createdAt: now,
  };

  return {
    session: forkedSession,
    agentName: DEMO_AGENT_NAMES[input.newAgentId] ?? 'Unknown Agent',
    contextMeta: {
      totalTurns: 0,
      includedVerbatimTurns: 0,
      summarizedTurns: 0,
      estimatedTokens: 0,
      previousAgent: 'Demo Agent',
    },
  };
}

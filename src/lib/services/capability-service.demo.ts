/**
 * Demo-mode shadow for capability-service.
 *
 * Exports fixture data for agent capabilities and re-implements every public
 * function without touching the database. Mutations are no-ops.
 *
 * Gemini has no capabilities — demonstrates auth-required UX state.
 */

import type { AgentCapability } from '@/lib/types';
import type { CapabilityFilters } from '@/lib/services/capability-service';

// ---------------------------------------------------------------------------
// Canonical demo UUIDs
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';

// ---------------------------------------------------------------------------
// Fixed timestamps
// ---------------------------------------------------------------------------

const T_7D_AGO = new Date('2026-04-16T10:00:00.000Z');
const T_6D_AGO = new Date('2026-04-17T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Helper to build capability fixtures
// ---------------------------------------------------------------------------

let capSeq = 0;
function makeCapId(): string {
  capSeq++;
  const hex = capSeq.toString(16).padStart(12, '0');
  return `cc000000-0000-4000-8000-${hex}`;
}

function makeCap(
  agentId: string,
  key: string,
  label: string,
  description: string,
  overrides: Partial<AgentCapability> = {},
): AgentCapability {
  return {
    id: makeCapId(),
    agentId,
    key,
    label,
    description,
    source: 'builtin',
    interactionMode: 'prompt',
    commandTokens: null,
    promptTemplate: null,
    argsSchema: {},
    requiresApproval: false,
    isEnabled: true,
    dangerLevel: 0,
    timeoutSec: 300,
    maxOutputBytes: 10 * 1024 * 1024,
    supportStatus: 'verified',
    providerNotes: null,
    lastTestedAt: T_7D_AGO,
    createdAt: T_7D_AGO,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Claude capabilities
// ---------------------------------------------------------------------------

export const DEMO_CAPABILITIES_CLAUDE: AgentCapability[] = [
  makeCap(CLAUDE_AGENT_ID, 'file:read', 'File Read', 'Read files from the repository'),
  makeCap(CLAUDE_AGENT_ID, 'file:write', 'File Write', 'Write and edit files in the repository', {
    dangerLevel: 1,
  }),
  makeCap(CLAUDE_AGENT_ID, 'shell:safe', 'Shell (safe)', 'Run non-destructive shell commands', {
    dangerLevel: 1,
  }),
  makeCap(
    CLAUDE_AGENT_ID,
    'shell:dangerous',
    'Shell (dangerous)',
    'Run potentially destructive commands (rm, truncate, etc.)',
    { dangerLevel: 3, requiresApproval: true },
  ),
  makeCap(CLAUDE_AGENT_ID, 'task:create', 'Create Task', 'Create new tasks via MCP'),
  makeCap(CLAUDE_AGENT_ID, 'task:update', 'Update Task', 'Update task status and fields via MCP'),
  makeCap(CLAUDE_AGENT_ID, 'session:list', 'List Sessions', 'List active agent sessions via MCP'),
  makeCap(
    CLAUDE_AGENT_ID,
    'web:search',
    'Web Search',
    'Search the web using built-in browser tool',
    { supportStatus: 'untested' },
  ),
];

// ---------------------------------------------------------------------------
// Codex capabilities
// ---------------------------------------------------------------------------

export const DEMO_CAPABILITIES_CODEX: AgentCapability[] = [
  makeCap(CODEX_AGENT_ID, 'file:read', 'File Read', 'Read files from the repository', {
    createdAt: T_6D_AGO,
    lastTestedAt: T_6D_AGO,
  }),
  makeCap(CODEX_AGENT_ID, 'file:write', 'File Write', 'Write and edit files in the repository', {
    dangerLevel: 1,
    createdAt: T_6D_AGO,
    lastTestedAt: T_6D_AGO,
  }),
  makeCap(CODEX_AGENT_ID, 'shell:safe', 'Shell (safe)', 'Run non-destructive shell commands', {
    dangerLevel: 1,
    createdAt: T_6D_AGO,
    lastTestedAt: T_6D_AGO,
  }),
  makeCap(CODEX_AGENT_ID, 'task:create', 'Create Task', 'Create new tasks via MCP', {
    supportStatus: 'unsupported',
    providerNotes: 'Codex does not support MCP tool calls.',
    createdAt: T_6D_AGO,
  }),
];

// ---------------------------------------------------------------------------
// Gemini capabilities — empty (auth-required, not yet configured)
// ---------------------------------------------------------------------------

export const DEMO_CAPABILITIES_GEMINI: AgentCapability[] = [];

// ---------------------------------------------------------------------------
// Lookup table
// ---------------------------------------------------------------------------

const ALL_CAPS: AgentCapability[] = [
  ...DEMO_CAPABILITIES_CLAUDE,
  ...DEMO_CAPABILITIES_CODEX,
  ...DEMO_CAPABILITIES_GEMINI,
];

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export function listCapabilities(agentId: string, filters?: CapabilityFilters): AgentCapability[] {
  let caps = ALL_CAPS.filter((c) => c.agentId === agentId);

  if (filters?.interactionMode) {
    caps = caps.filter((c) => c.interactionMode === filters.interactionMode);
  }
  if (filters?.supportStatus) {
    caps = caps.filter((c) => c.supportStatus === filters.supportStatus);
  }
  if (filters?.isEnabled !== undefined) {
    caps = caps.filter((c) => c.isEnabled === filters.isEnabled);
  }

  return caps;
}

export function getCapability(id: string): AgentCapability | undefined {
  return ALL_CAPS.find((c) => c.id === id);
}

export function getCapabilityByKey(agentId: string, key: string): AgentCapability | undefined {
  return ALL_CAPS.find((c) => c.agentId === agentId && c.key === key);
}

// ---------------------------------------------------------------------------
// Mutation stubs — no side effects
// ---------------------------------------------------------------------------

export function createCapability(data: Partial<AgentCapability>): AgentCapability {
  const now = new Date();
  return {
    id: makeCapId(),
    agentId: data.agentId ?? '',
    key: data.key ?? 'demo:stub',
    label: data.label ?? 'Demo capability',
    description: data.description ?? null,
    source: data.source ?? 'manual',
    interactionMode: data.interactionMode ?? 'prompt',
    commandTokens: data.commandTokens ?? null,
    promptTemplate: data.promptTemplate ?? null,
    argsSchema: data.argsSchema ?? {},
    requiresApproval: data.requiresApproval ?? false,
    isEnabled: data.isEnabled ?? true,
    dangerLevel: data.dangerLevel ?? 0,
    timeoutSec: data.timeoutSec ?? 300,
    maxOutputBytes: data.maxOutputBytes ?? 10 * 1024 * 1024,
    supportStatus: data.supportStatus ?? 'untested',
    providerNotes: data.providerNotes ?? null,
    lastTestedAt: data.lastTestedAt ?? null,
    createdAt: now,
  };
}

export function updateCapability(
  _id: string,
  data: Partial<AgentCapability>,
): AgentCapability | undefined {
  const existing = ALL_CAPS.find((c) => c.id === _id);
  if (!existing) return undefined;
  return { ...existing, ...data };
}

export function deleteCapability(_id: string): boolean {
  return false; // no-op
}

export function bulkSetSupportStatus(
  agentId: string,
  key: string,
  _status: string,
  _notes?: string,
): AgentCapability | undefined {
  return ALL_CAPS.find((c) => c.agentId === agentId && c.key === key);
}

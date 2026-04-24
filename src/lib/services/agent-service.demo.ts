/**
 * Demo-mode shadow for agent-service.
 *
 * Exports fixture data and re-implements every public function from
 * agent-service.ts without touching the database. Mutations are no-ops.
 */

import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@/lib/errors';
import type { Agent } from '@/lib/types';
import type { DiscoveredTool } from '@/lib/discovery';

// ---------------------------------------------------------------------------
// Canonical demo UUIDs
// ---------------------------------------------------------------------------

export const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
export const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
export const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';

// ---------------------------------------------------------------------------
// Fixed timestamps
// ---------------------------------------------------------------------------

const T_7D_AGO = new Date('2026-04-16T10:00:00.000Z');
const T_6D_AGO = new Date('2026-04-17T10:00:00.000Z');
const T_5D_AGO = new Date('2026-04-18T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures — must satisfy typeof agents.$inferSelect
// ---------------------------------------------------------------------------

export const DEMO_AGENT_CLAUDE: Agent = {
  id: CLAUDE_AGENT_ID,
  ownerId: '00000000-0000-0000-0000-000000000001',
  workspaceId: '00000000-0000-0000-0000-000000000001',
  name: 'Claude Code',
  slug: 'claude-code',
  kind: 'builtin',
  binaryPath: '/usr/local/bin/claude',
  baseArgs: [],
  workingDir: '/home/ubuntu/projects',
  envAllowlist: ['PATH', 'HOME', 'ANTHROPIC_API_KEY'],
  isActive: true,
  maxConcurrent: 3,
  discoveryMethod: 'preset',
  version: '1.10.0',
  packageName: '@anthropic-ai/claude-code',
  packageSection: 'ai-agents',
  toolType: 'ai-agent',
  mcpEnabled: true,
  sessionConfig: {
    sessionIdSource: 'json_field',
    sessionIdField: 'session_id',
    bidirectionalProtocol: 'stream-json',
    resumeFlags: ['--resume'],
    continueFlags: ['--continue'],
  },
  lastScannedAt: T_7D_AGO,
  parsedFlags: [
    {
      flags: ['--model', '-m'],
      description: 'Claude model to use',
      takesValue: true,
      valueHint: 'MODEL',
    },
    {
      flags: ['--max-tokens'],
      description: 'Maximum tokens per response',
      takesValue: true,
      valueHint: 'NUM',
    },
  ],
  metadata: {
    icon: 'claude',
    color: '#D97706',
    description: 'Anthropic Claude Code — AI pair programmer',
    homepage: 'https://claude.ai/code',
  },
  createdAt: T_7D_AGO,
  updatedAt: T_7D_AGO,
};

export const DEMO_AGENT_CODEX: Agent = {
  id: CODEX_AGENT_ID,
  ownerId: '00000000-0000-0000-0000-000000000001',
  workspaceId: '00000000-0000-0000-0000-000000000001',
  name: 'Codex CLI',
  slug: 'codex-cli',
  kind: 'builtin',
  binaryPath: '/usr/local/bin/codex',
  baseArgs: ['app-server'],
  workingDir: '/home/ubuntu/projects',
  envAllowlist: ['PATH', 'HOME', 'OPENAI_API_KEY'],
  isActive: true,
  maxConcurrent: 2,
  discoveryMethod: 'preset',
  version: '0.1.2504',
  packageName: '@openai/codex',
  packageSection: 'ai-agents',
  toolType: 'ai-agent',
  mcpEnabled: false,
  sessionConfig: {
    sessionIdSource: 'json_field',
    sessionIdField: 'session_id',
    bidirectionalProtocol: 'app-server',
    resumeFlags: [],
    continueFlags: [],
  },
  lastScannedAt: T_6D_AGO,
  parsedFlags: [
    {
      flags: ['--model'],
      description: 'OpenAI model to use',
      takesValue: true,
      valueHint: 'MODEL',
    },
  ],
  metadata: {
    icon: 'openai',
    color: '#10B981',
    description: 'OpenAI Codex CLI — code generation and editing',
    homepage: 'https://github.com/openai/codex',
  },
  createdAt: T_6D_AGO,
  updatedAt: T_6D_AGO,
};

/**
 * Gemini is `isActive: false` — simulates auth-required state.
 * The demo narrative: user hasn't authenticated Gemini yet.
 * The `metadata.description` carries the auth-required narrative for the UI.
 */
export const DEMO_AGENT_GEMINI: Agent = {
  id: GEMINI_AGENT_ID,
  ownerId: '00000000-0000-0000-0000-000000000001',
  workspaceId: '00000000-0000-0000-0000-000000000001',
  name: 'Gemini CLI',
  slug: 'gemini-cli',
  kind: 'builtin',
  binaryPath: '/usr/local/bin/gemini',
  baseArgs: [],
  workingDir: '/home/ubuntu/projects',
  envAllowlist: ['PATH', 'HOME', 'GEMINI_API_KEY'],
  isActive: false, // auth-required: agent not authenticated
  maxConcurrent: 2,
  discoveryMethod: 'preset',
  version: '0.1.5',
  packageName: '@google/gemini-cli',
  packageSection: 'ai-agents',
  toolType: 'ai-agent',
  mcpEnabled: false,
  sessionConfig: {
    sessionIdSource: 'acp',
    bidirectionalProtocol: 'acp',
    resumeFlags: [],
    continueFlags: [],
  },
  lastScannedAt: T_5D_AGO,
  parsedFlags: [],
  metadata: {
    icon: 'gemini',
    color: '#6366F1',
    description: 'Authentication required — run `gemini auth login` to activate.',
    homepage: 'https://github.com/google-gemini/gemini-cli',
  },
  createdAt: T_5D_AGO,
  updatedAt: T_5D_AGO,
};

export const ALL_DEMO_AGENTS: Agent[] = [DEMO_AGENT_CLAUDE, DEMO_AGENT_CODEX, DEMO_AGENT_GEMINI];

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export function getAgentById(id: string): Agent {
  const agent = ALL_DEMO_AGENTS.find((a) => a.id === id);
  if (!agent) throw new NotFoundError('Agent', id);
  return agent;
}

export function listAgents(): Agent[] {
  return ALL_DEMO_AGENTS;
}

export function getAgentBySlug(slug: string): Agent | null {
  return ALL_DEMO_AGENTS.find((a) => a.slug === slug) ?? null;
}

export function getExistingSlugs(): Set<string> {
  return new Set(ALL_DEMO_AGENTS.map((a) => a.slug));
}

export function getExistingBinaryPaths(): Set<string> {
  return new Set(ALL_DEMO_AGENTS.map((a) => a.binaryPath));
}

// ---------------------------------------------------------------------------
// Mutation stubs — no side effects
// ---------------------------------------------------------------------------

/** Returns a stub agent without touching DB. */
export function createAgent(data: { name: string; binaryPath: string }): Agent {
  const now = new Date();
  return {
    id: 'demo-stub-agent-' + Date.now(),
    ownerId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000001',
    name: data.name,
    slug: data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    kind: 'custom',
    binaryPath: data.binaryPath,
    baseArgs: [],
    workingDir: null,
    envAllowlist: [],
    isActive: true,
    maxConcurrent: 1,
    discoveryMethod: 'manual',
    version: null,
    packageName: null,
    packageSection: null,
    toolType: 'ai-agent',
    mcpEnabled: false,
    sessionConfig: null,
    lastScannedAt: null,
    parsedFlags: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Synthesizes a new agent row from a DiscoveredTool without hitting the DB.
 * Mimics the logic in the real createFromDiscovery: uses preset data when available,
 * falls back to raw tool metadata otherwise.
 */
export function createFromDiscovery(tool: DiscoveredTool): Agent {
  const now = new Date();
  const preset = tool.preset;
  const name = preset?.displayName ?? tool.name;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    id: randomUUID(),
    ownerId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000001',
    name,
    slug,
    kind: preset ? 'builtin' : 'custom',
    binaryPath: tool.path,
    baseArgs: [],
    workingDir: null,
    envAllowlist: preset?.envAllowlist ?? [],
    isActive: true,
    maxConcurrent: preset?.maxConcurrent ?? 1,
    discoveryMethod: preset ? 'preset' : 'path_scan',
    version: tool.version,
    packageName: tool.packageName,
    packageSection: tool.packageSection,
    toolType: tool.toolType,
    mcpEnabled: preset?.mcpEnabled ?? false,
    sessionConfig: preset?.sessionConfig ?? null,
    lastScannedAt: now,
    parsedFlags: tool.schema?.options ?? [],
    metadata: preset?.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  } satisfies Agent;
}

/** Returns stub updated agent without DB. */
export function updateAgent(id: string, data: Record<string, unknown>): Agent {
  const existing = ALL_DEMO_AGENTS.find((a) => a.id === id);
  const base = existing ?? DEMO_AGENT_CLAUDE;
  return { ...base, ...data, id, updatedAt: new Date() };
}

/** No-op delete in demo mode. */
export function deleteAgent(_id: string): void {
  // No side effects
}

/** No-op flag update in demo mode. */
export function updateAgentParsedFlags(_id: string, _flags: unknown[]): void {
  // No side effects
}

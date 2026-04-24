/**
 * Demo mode tests for agent-service and capability-service.
 *
 * Strategy: mock isDemoMode to return true and exercise the real service
 * functions to verify the demo shadow is correctly wired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/demo/flag', () => ({
  isDemoMode: vi.fn(() => true),
}));

vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('DB should not be accessed in demo mode');
      },
    },
  ),
}));

// Mock fs for validateBinaryPath in the real agent-service
vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

// Mock discovery dep
vi.mock('@/lib/discovery/schema-extractor', () => ({
  getHelpText: vi.fn(),
  quickParseHelp: vi.fn(),
}));

import {
  getAgentById,
  listAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentBySlug,
  createFromDiscovery,
} from '@/lib/services/agent-service';
import {
  listCapabilities,
  getCapability,
  getCapabilityByKey,
} from '@/lib/services/capability-service';

import {
  DEMO_AGENT_CLAUDE,
  DEMO_AGENT_CODEX,
  DEMO_AGENT_GEMINI,
} from '@/lib/services/agent-service.demo';

import {
  DEMO_CAPABILITIES_CLAUDE,
  DEMO_CAPABILITIES_CODEX,
  DEMO_CAPABILITIES_GEMINI,
} from '@/lib/services/capability-service.demo';

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';

describe('agent-service (demo mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Fixture shape -------------------------------------------------------

  describe('demo agent fixtures', () => {
    it('claude agent has correct id and name', () => {
      expect(DEMO_AGENT_CLAUDE.id).toBe(CLAUDE_AGENT_ID);
      expect(DEMO_AGENT_CLAUDE.name).toBe('Claude Code');
      expect(DEMO_AGENT_CLAUDE.isActive).toBe(true);
    });

    it('codex agent has correct id and name', () => {
      expect(DEMO_AGENT_CODEX.id).toBe(CODEX_AGENT_ID);
      expect(DEMO_AGENT_CODEX.name).toBe('Codex CLI');
      expect(DEMO_AGENT_CODEX.isActive).toBe(true);
    });

    it('gemini agent is inactive (auth-required simulation)', () => {
      expect(DEMO_AGENT_GEMINI.id).toBe(GEMINI_AGENT_ID);
      expect(DEMO_AGENT_GEMINI.name).toBe('Gemini CLI');
      expect(DEMO_AGENT_GEMINI.isActive).toBe(false);
    });

    it('all agents have required non-nullable fields', () => {
      for (const agent of [DEMO_AGENT_CLAUDE, DEMO_AGENT_CODEX, DEMO_AGENT_GEMINI]) {
        expect(agent.id).toBeTruthy();
        expect(agent.name).toBeTruthy();
        expect(agent.slug).toBeTruthy();
        expect(agent.binaryPath).toBeTruthy();
        expect(agent.kind).toBeTruthy();
        expect(agent.createdAt).toBeInstanceOf(Date);
        expect(agent.updatedAt).toBeInstanceOf(Date);
        expect(Array.isArray(agent.parsedFlags)).toBe(true);
        expect(Array.isArray(agent.baseArgs)).toBe(true);
        expect(Array.isArray(agent.envAllowlist)).toBe(true);
      }
    });

    it('binaryPath basenames match expected agent names', () => {
      expect(DEMO_AGENT_CLAUDE.binaryPath).toMatch(/claude$/);
      expect(DEMO_AGENT_CODEX.binaryPath).toMatch(/codex$/);
      expect(DEMO_AGENT_GEMINI.binaryPath).toMatch(/gemini$/);
    });
  });

  // ---- Service function routing -------------------------------------------

  describe('getAgentById', () => {
    it('returns claude agent for correct id', async () => {
      const agent = await getAgentById(CLAUDE_AGENT_ID);
      expect(agent.id).toBe(CLAUDE_AGENT_ID);
      expect(agent.name).toBe('Claude Code');
    });

    it('returns gemini agent for correct id', async () => {
      const agent = await getAgentById(GEMINI_AGENT_ID);
      expect(agent.id).toBe(GEMINI_AGENT_ID);
    });

    it('throws NotFoundError for unknown id', async () => {
      await expect(getAgentById('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });

  describe('listAgents', () => {
    it('returns all 3 demo agents', async () => {
      const agents = await listAgents();
      expect(agents).toHaveLength(3);
    });

    it('returns agents with correct types', async () => {
      const agents = await listAgents();
      for (const agent of agents) {
        expect(typeof agent.id).toBe('string');
        expect(typeof agent.name).toBe('string');
        expect(typeof agent.slug).toBe('string');
        expect(typeof agent.binaryPath).toBe('string');
      }
    });
  });

  describe('getAgentBySlug', () => {
    it('returns claude agent by slug', async () => {
      const agent = await getAgentBySlug('claude-code');
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe(CLAUDE_AGENT_ID);
    });

    it('returns null for unknown slug', async () => {
      const agent = await getAgentBySlug('nonexistent-agent');
      expect(agent).toBeNull();
    });
  });

  // ---- Mutations — no side effects in demo mode ---------------------------

  describe('createAgent (demo mode noop)', () => {
    it('returns a stub agent without hitting DB', async () => {
      const agent = await createAgent({
        name: 'Test Agent',
        binaryPath: '/usr/bin/test',
      });
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe('Test Agent');
    });
  });

  describe('updateAgent (demo mode noop)', () => {
    it('returns a stub update without hitting DB', async () => {
      const result = await updateAgent(CLAUDE_AGENT_ID, { name: 'Updated' });
      expect(result.id).toBeTruthy();
    });
  });

  describe('deleteAgent (demo mode noop)', () => {
    it('resolves without throwing', async () => {
      await expect(deleteAgent(CLAUDE_AGENT_ID)).resolves.toBeUndefined();
    });
  });

  describe('createFromDiscovery (demo mode stub)', () => {
    it('returns a stub agent without hitting DB', async () => {
      const tool = {
        name: 'my-ai-tool',
        path: '/usr/bin/my-ai-tool',
        realPath: '/usr/bin/my-ai-tool',
        isSymlink: false,
        toolType: 'ai-agent',
        version: '1.0.0',
        packageName: '@acme/my-ai-tool',
        packageSection: 'ai-agents',
        description: 'Test AI tool',
        fileType: 'elf',
        schema: null,
        preset: null,
        isConfirmed: true,
      };
      const agent = await createFromDiscovery(tool);
      expect(agent.id).toBeTruthy();
      expect(agent.binaryPath).toBe('/usr/bin/my-ai-tool');
      expect(agent.name).toBeTruthy();
      expect(agent.createdAt).toBeInstanceOf(Date);
    });

    it('returns agent with custom kind when no preset', async () => {
      const tool = {
        name: 'my-ai-tool',
        path: '/usr/bin/my-ai-tool',
        realPath: '/usr/bin/my-ai-tool',
        isSymlink: false,
        toolType: 'ai-agent',
        version: null,
        packageName: null,
        packageSection: null,
        description: null,
        fileType: null,
        schema: null,
        preset: null,
        isConfirmed: true,
      };
      const agent = await createFromDiscovery(tool);
      expect(agent.kind).toBe('custom');
      expect(agent.discoveryMethod).toBe('path_scan');
    });
  });
});

describe('capability-service (demo mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Fixture shape -------------------------------------------------------

  describe('demo capability fixtures', () => {
    it('claude has capabilities with verified status', () => {
      expect(DEMO_CAPABILITIES_CLAUDE.length).toBeGreaterThan(0);
      expect(DEMO_CAPABILITIES_CLAUDE.every((c) => c.agentId === CLAUDE_AGENT_ID)).toBe(true);
    });

    it('codex has capabilities', () => {
      expect(DEMO_CAPABILITIES_CODEX.length).toBeGreaterThan(0);
      expect(DEMO_CAPABILITIES_CODEX.every((c) => c.agentId === CODEX_AGENT_ID)).toBe(true);
    });

    it('gemini has no capabilities (auth-required demo)', () => {
      expect(DEMO_CAPABILITIES_GEMINI).toHaveLength(0);
    });

    it('all capability fixtures have required fields', () => {
      for (const cap of [...DEMO_CAPABILITIES_CLAUDE, ...DEMO_CAPABILITIES_CODEX]) {
        expect(cap.id).toBeTruthy();
        expect(cap.agentId).toBeTruthy();
        expect(cap.key).toBeTruthy();
        expect(cap.label).toBeTruthy();
        expect(typeof cap.isEnabled).toBe('boolean');
        expect(typeof cap.requiresApproval).toBe('boolean');
        expect(typeof cap.dangerLevel).toBe('number');
        expect(typeof cap.timeoutSec).toBe('number');
        expect(typeof cap.maxOutputBytes).toBe('number');
        expect(cap.createdAt).toBeInstanceOf(Date);
      }
    });
  });

  // ---- Service function routing -------------------------------------------

  describe('listCapabilities', () => {
    it('returns claude capabilities', async () => {
      const caps = await listCapabilities(CLAUDE_AGENT_ID);
      expect(caps.length).toBeGreaterThan(0);
      expect(caps.every((c) => c.agentId === CLAUDE_AGENT_ID)).toBe(true);
    });

    it('returns empty array for gemini (auth-required)', async () => {
      const caps = await listCapabilities(GEMINI_AGENT_ID);
      expect(caps).toHaveLength(0);
    });

    it('returns empty array for unknown agentId', async () => {
      const caps = await listCapabilities('00000000-0000-0000-0000-000000000099');
      expect(caps).toHaveLength(0);
    });

    it('filters by isEnabled', async () => {
      const caps = await listCapabilities(CLAUDE_AGENT_ID, { isEnabled: true });
      expect(caps.every((c) => c.isEnabled === true)).toBe(true);
    });

    it('filters by supportStatus', async () => {
      const caps = await listCapabilities(CLAUDE_AGENT_ID, { supportStatus: 'verified' });
      expect(caps.every((c) => c.supportStatus === 'verified')).toBe(true);
    });
  });

  describe('getCapability', () => {
    it('returns capability for known id', async () => {
      const cap = DEMO_CAPABILITIES_CLAUDE[0];
      const result = await getCapability(cap.id);
      expect(result).toBeDefined();
      expect(result!.id).toBe(cap.id);
    });

    it('returns undefined for unknown id', async () => {
      const result = await getCapability('00000000-0000-0000-0000-000000000099');
      expect(result).toBeUndefined();
    });
  });

  describe('getCapabilityByKey', () => {
    it('returns capability for known agentId + key', async () => {
      const cap = DEMO_CAPABILITIES_CLAUDE[0];
      const result = await getCapabilityByKey(CLAUDE_AGENT_ID, cap.key);
      expect(result).toBeDefined();
      expect(result!.key).toBe(cap.key);
    });

    it('returns undefined for unknown key', async () => {
      const result = await getCapabilityByKey(CLAUDE_AGENT_ID, 'nonexistent:key');
      expect(result).toBeUndefined();
    });
  });
});

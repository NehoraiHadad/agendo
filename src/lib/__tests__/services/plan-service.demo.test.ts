/**
 * Demo mode tests for plan-service.
 *
 * Strategy: mock isDemoMode() to true and mock DB to throw on access, then
 * exercise the real service functions. The demo branch must route to the
 * shadow and never touch the DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Demo mode on before any imports ----------------------------------------

vi.mock('@/lib/demo/flag', () => ({
  isDemoMode: vi.fn(() => true),
}));

// Safety-net: DB must not be accessed in demo mode
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

// Stubs for all modules plan-service imports at module level
vi.mock('@/lib/services/artifact-service', () => ({
  createArtifact: vi.fn(),
}));

vi.mock('@/lib/services/session-helpers', () => ({
  createAndEnqueueSession: vi.fn(),
}));

vi.mock('@/lib/services/agent-service', () => ({
  getAgentById: vi.fn(),
}));

vi.mock('@/lib/services/task-service', () => ({
  createTask: vi.fn(),
}));

vi.mock('@/lib/worker/agent-utils', () => ({
  getBinaryName: vi.fn(() => 'claude'),
}));

vi.mock('@/lib/worker/session-preambles', () => ({
  buildPlanContext: vi.fn(() => 'mock plan context'),
  generatePlanConversationPreamble: vi.fn(() => ({
    prompt: 'mock preamble',
    permissionMode: 'plan',
  })),
}));

vi.mock('@/lib/utils/git', () => ({
  getGitHead: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createPlan,
  getPlan,
  listPlans,
  updatePlan,
  archivePlan,
  executePlan,
  breakPlanIntoTasks,
  startPlanConversation,
  savePlanFromMcp,
  savePlanContent,
  listPlanVersions,
  getPlanVersion,
  comparePlanVersions,
  validatePlan,
  searchPlans,
} from '@/lib/services/plan-service';

import {
  DEMO_PLAN,
  DEMO_PLAN_ID,
  DEMO_PLAN_VERSIONS,
  DEMO_PLAN_VERSION_IDS,
} from '@/lib/services/plan-service.demo';

// ---------------------------------------------------------------------------
// Canonical IDs
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';

describe('plan-service (demo mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Fixture shape -------------------------------------------------------

  describe('demo fixtures', () => {
    it('DEMO_PLAN has correct id and status', () => {
      expect(DEMO_PLAN.id).toBe(DEMO_PLAN_ID);
      expect(DEMO_PLAN.status).toBe('done');
    });

    it('DEMO_PLAN has correct title', () => {
      expect(DEMO_PLAN.title).toBe('Add MCP tool for task breakdown');
    });

    it('DEMO_PLAN projectId is agendo project', () => {
      expect(DEMO_PLAN.projectId).toBe(AGENDO_PROJECT_ID);
    });

    it('DEMO_PLAN has non-empty content with subtask breakdown', () => {
      expect(typeof DEMO_PLAN.content).toBe('string');
      expect(DEMO_PLAN.content.length).toBeGreaterThan(100);
    });

    it('DEMO_PLAN required non-nullable fields', () => {
      expect(DEMO_PLAN.id).toBeTruthy();
      expect(DEMO_PLAN.title).toBeTruthy();
      expect(DEMO_PLAN.content).toBeTruthy();
      expect(DEMO_PLAN.projectId).toBeTruthy();
      expect(DEMO_PLAN.createdAt).toBeInstanceOf(Date);
      expect(DEMO_PLAN.updatedAt).toBeInstanceOf(Date);
    });

    it('DEMO_PLAN_VERSIONS has multiple versions', () => {
      expect(DEMO_PLAN_VERSIONS.length).toBeGreaterThanOrEqual(2);
    });

    it('DEMO_PLAN_VERSIONS each have required fields', () => {
      for (const v of DEMO_PLAN_VERSIONS) {
        expect(v.id).toBeTruthy();
        expect(v.planId).toBe(DEMO_PLAN_ID);
        expect(typeof v.version).toBe('number');
        expect(v.version).toBeGreaterThan(0);
        expect(typeof v.content).toBe('string');
        expect(typeof v.title).toBe('string');
        expect(v.createdAt).toBeInstanceOf(Date);
      }
    });

    it('DEMO_PLAN_VERSION_IDS has correct count matching DEMO_PLAN_VERSIONS', () => {
      expect(DEMO_PLAN_VERSION_IDS.length).toBe(DEMO_PLAN_VERSIONS.length);
    });
  });

  // ---- Read functions -------------------------------------------------------

  describe('getPlan', () => {
    it('returns demo plan for known id', async () => {
      const plan = await getPlan(DEMO_PLAN_ID);
      expect(plan.id).toBe(DEMO_PLAN_ID);
      expect(plan.status).toBe('done');
    });

    it('throws for unknown id in demo mode', async () => {
      await expect(getPlan('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    });
  });

  describe('listPlans', () => {
    it('returns all demo plans when no filters', async () => {
      const plans = await listPlans();
      expect(plans.length).toBeGreaterThan(0);
    });

    it('filters by projectId', async () => {
      const plans = await listPlans({ projectId: AGENDO_PROJECT_ID });
      expect(plans.every((p) => p.projectId === AGENDO_PROJECT_ID)).toBe(true);
    });

    it('filters by status done', async () => {
      const plans = await listPlans({ status: 'done' });
      expect(plans.every((p) => p.status === 'done')).toBe(true);
    });

    it('returns Plan shape with required fields', async () => {
      const plans = await listPlans();
      for (const p of plans) {
        expect(typeof p.id).toBe('string');
        expect(typeof p.title).toBe('string');
        expect(typeof p.status).toBe('string');
        expect(typeof p.projectId).toBe('string');
        expect(p.createdAt).toBeInstanceOf(Date);
        expect(p.updatedAt).toBeInstanceOf(Date);
      }
    });

    it('returns empty array for unknown projectId', async () => {
      const plans = await listPlans({ projectId: '00000000-0000-0000-0000-000000000099' });
      expect(plans).toHaveLength(0);
    });
  });

  describe('searchPlans', () => {
    it('returns matching plans for query "MCP"', async () => {
      const results = await searchPlans('MCP');
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns empty array for no match', async () => {
      const results = await searchPlans('zzz-no-match-xyz');
      expect(results).toHaveLength(0);
    });

    it('returns SearchPlanResult shape', async () => {
      const results = await searchPlans('breakdown');
      for (const r of results) {
        expect(typeof r.id).toBe('string');
        expect(typeof r.title).toBe('string');
        expect(typeof r.status).toBe('string');
        expect(typeof r.projectId).toBe('string');
      }
    });
  });

  describe('listPlanVersions', () => {
    it('returns versions for known plan', async () => {
      const versions = await listPlanVersions(DEMO_PLAN_ID);
      expect(versions.length).toBeGreaterThanOrEqual(2);
    });

    it('each version has required fields', async () => {
      const versions = await listPlanVersions(DEMO_PLAN_ID);
      for (const v of versions) {
        expect(typeof v.id).toBe('string');
        expect(typeof v.version).toBe('number');
        expect(typeof v.title).toBe('string');
        expect(v.createdAt).toBeInstanceOf(Date);
      }
    });

    it('returns empty for unknown planId', async () => {
      const versions = await listPlanVersions('00000000-0000-0000-0000-000000000099');
      expect(versions).toHaveLength(0);
    });
  });

  describe('getPlanVersion', () => {
    it('returns version 1 for demo plan', async () => {
      const version = await getPlanVersion(DEMO_PLAN_ID, 1);
      expect(version.planId).toBe(DEMO_PLAN_ID);
      expect(version.version).toBe(1);
      expect(typeof version.content).toBe('string');
    });

    it('throws for unknown version number', async () => {
      await expect(getPlanVersion(DEMO_PLAN_ID, 999)).rejects.toThrow();
    });
  });

  describe('comparePlanVersions', () => {
    it('returns both versions for valid v1, v2', async () => {
      const result = await comparePlanVersions(DEMO_PLAN_ID, 1, 2);
      expect(result.v1.version).toBe(1);
      expect(result.v2.version).toBe(2);
    });
  });

  // ---- Mutation stubs -------------------------------------------------------

  describe('createPlan (demo stub)', () => {
    it('returns a plan stub without hitting DB', async () => {
      const result = await createPlan({
        projectId: AGENDO_PROJECT_ID,
        title: 'New demo plan',
        content: '## Step 1\nDo something.',
      });
      expect(result.id).toBeTruthy();
      expect(result.title).toBe('New demo plan');
      expect(result.status).toBe('draft');
      expect(result.projectId).toBe(AGENDO_PROJECT_ID);
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('updatePlan (demo stub)', () => {
    it('returns stub with merged patch for known id', async () => {
      const result = await updatePlan(DEMO_PLAN_ID, { title: 'Updated Title' });
      expect(result.id).toBe(DEMO_PLAN_ID);
      expect(result.title).toBe('Updated Title');
    });

    it('returns stub with merged patch for unknown id', async () => {
      const result = await updatePlan('00000000-0000-0000-0000-000000000099', {
        title: 'New Title',
      });
      expect(result.title).toBe('New Title');
    });
  });

  describe('archivePlan (demo stub)', () => {
    it('resolves without throwing', async () => {
      await expect(archivePlan(DEMO_PLAN_ID)).resolves.toBeUndefined();
    });
  });

  describe('executePlan (demo stub)', () => {
    it('returns sessionId and taskId without hitting DB', async () => {
      const result = await executePlan(DEMO_PLAN_ID, { agentId: CLAUDE_AGENT_ID });
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(typeof result.taskId).toBe('string');
      expect(result.taskId.length).toBeGreaterThan(0);
    });
  });

  describe('breakPlanIntoTasks (demo stub)', () => {
    it('returns sessionId without hitting DB', async () => {
      const result = await breakPlanIntoTasks(DEMO_PLAN_ID, { agentId: CLAUDE_AGENT_ID });
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId.length).toBeGreaterThan(0);
    });
  });

  describe('startPlanConversation (demo stub)', () => {
    it('returns sessionId without hitting DB', async () => {
      const result = await startPlanConversation(DEMO_PLAN_ID, { agentId: CLAUDE_AGENT_ID });
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId.length).toBeGreaterThan(0);
    });
  });

  describe('validatePlan (demo stub)', () => {
    it('returns sessionId without hitting DB', async () => {
      const result = await validatePlan(DEMO_PLAN_ID, { agentId: CLAUDE_AGENT_ID });
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId.length).toBeGreaterThan(0);
    });
  });

  describe('savePlanContent (demo stub)', () => {
    it('returns null (deduplication — no change in demo)', async () => {
      const result = await savePlanContent(DEMO_PLAN_ID, DEMO_PLAN.content);
      // null means content unchanged (deduplication)
      expect(result).toBeNull();
    });

    it('returns a new version stub when content differs', async () => {
      const result = await savePlanContent(DEMO_PLAN_ID, 'brand new content that differs');
      expect(result).not.toBeNull();
      expect(result!.planId).toBe(DEMO_PLAN_ID);
      expect(typeof result!.version).toBe('number');
    });
  });

  describe('savePlanFromMcp (demo stub)', () => {
    it('returns { planId, title, action: created } for unknown sessionId', async () => {
      const result = await savePlanFromMcp(
        undefined,
        '## New Plan\nContent.',
        'New Plan',
        undefined,
      );
      expect(typeof result.planId).toBe('string');
      expect(result.planId.length).toBeGreaterThan(0);
      expect(result.title).toBe('New Plan');
      expect(['created', 'updated']).toContain(result.action);
    });

    it('returns { action: updated } when planId is provided', async () => {
      const result = await savePlanFromMcp(
        undefined,
        '## Updated Plan\nNew content.',
        'Updated Plan',
        DEMO_PLAN_ID,
      );
      expect(result.planId).toBe(DEMO_PLAN_ID);
      expect(result.action).toBe('updated');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifySessionError } from '@/lib/worker/fallback/error-classifier';
import {
  decideFallback,
  resolveFallbackModelCandidates,
  selectFallbackAgentCandidate,
} from '@/lib/worker/fallback/fallback-engine';

const { mockGetModelsForProvider } = vi.hoisted(() => ({
  mockGetModelsForProvider: vi.fn(),
}));

vi.mock('@/lib/services/model-service', () => ({
  getModelsForProvider: mockGetModelsForProvider,
}));

describe('classifySessionError', () => {
  it('classifies usage limit errors', () => {
    expect(classifySessionError("Codex turn failed: You've hit your usage limit.")).toEqual({
      category: 'usage_limit',
      summary: 'Usage limit reached',
      rawMessage: "Codex turn failed: You've hit your usage limit.",
    });
  });

  it('classifies authentication errors', () => {
    expect(classifySessionError('Unauthorized: invalid_api_key')).toEqual({
      category: 'auth_error',
      summary: 'Authentication failed',
      rawMessage: 'Unauthorized: invalid_api_key',
    });
  });

  it('returns null for unclassified transport noise', () => {
    expect(classifySessionError('stream interrupted while waiting for more tokens')).toBeNull();
  });
});

describe('resolveFallbackModelCandidates', () => {
  beforeEach(() => {
    mockGetModelsForProvider.mockReset();
  });

  it('prefers policy-configured agent-specific models', async () => {
    const models = await resolveFallbackModelCandidates({
      policy: {
        allowedFallbackModels: {
          byAgent: {
            'codex-cli-1': ['gpt-4o', 'o3-mini'],
          },
        },
      },
      participant: {
        agentSlug: 'codex-cli-1',
        provider: 'openai',
        model: 'codex-max',
      },
      attemptedModels: ['gpt-4o'],
    });

    expect(models).toEqual(['o3-mini']);
    expect(mockGetModelsForProvider).not.toHaveBeenCalled();
  });

  it('falls back to discovered provider models when no policy order exists', async () => {
    mockGetModelsForProvider.mockResolvedValue([
      { id: 'codex-max', label: 'Codex Max', description: 'Default' },
      { id: 'gpt-4o', label: 'GPT-4o', description: 'Fallback' },
      { id: 'o3-mini', label: 'o3-mini', description: 'Fallback' },
    ]);

    const models = await resolveFallbackModelCandidates({
      participant: {
        agentSlug: 'codex-cli-1',
        provider: 'openai',
        model: 'codex-max',
      },
      attemptedModels: ['gpt-4o'],
    });

    expect(models).toEqual(['o3-mini']);
    expect(mockGetModelsForProvider).toHaveBeenCalledWith('openai');
  });
});

describe('selectFallbackAgentCandidate', () => {
  it('respects configured agent order and skips attempted agents', () => {
    const candidate = selectFallbackAgentCandidate({
      policy: { allowedFallbackAgents: ['claude-code-1', 'gemini-cli-1'] },
      participant: { agentId: 'agent-codex', agentSlug: 'codex-cli-1' },
      attemptedAgents: ['agent-claude'],
      availableAgents: [
        {
          agentId: 'agent-claude',
          agentName: 'Claude',
          agentSlug: 'claude-code-1',
          provider: 'anthropic',
        },
        {
          agentId: 'agent-gemini',
          agentName: 'Gemini',
          agentSlug: 'gemini-cli-1',
          provider: 'google',
        },
      ],
    });

    expect(candidate?.agentId).toBe('agent-gemini');
  });
});

describe('decideFallback', () => {
  beforeEach(() => {
    mockGetModelsForProvider.mockReset();
  });

  it('returns model fallback when policy and discovered models allow it', async () => {
    mockGetModelsForProvider.mockResolvedValue([
      { id: 'codex-max', label: 'Codex Max', description: 'Default' },
      { id: 'gpt-4o', label: 'GPT-4o', description: 'Fallback' },
    ]);

    const decision = await decideFallback({
      error: {
        category: 'usage_limit',
        summary: 'Usage limit reached',
        rawMessage: 'usageLimitExceeded',
      },
      participant: {
        agentId: 'agent-codex',
        agentName: 'Codex',
        agentSlug: 'codex-cli-1',
        provider: 'openai',
        model: 'codex-max',
        modelPinned: false,
        supportsModelSwitch: true,
      },
      attemptedModels: [],
      attemptedAgents: [],
      availableAgents: [],
    });

    expect(decision).toMatchObject({
      type: 'switch_model',
      model: 'gpt-4o',
      reason: 'usage_limit',
    });
  });

  it('escalates to agent fallback when model fallback is blocked by a pinned model', async () => {
    const decision = await decideFallback({
      policy: { mode: 'model_then_agent', preservePinnedModel: true },
      error: {
        category: 'usage_limit',
        summary: 'Usage limit reached',
        rawMessage: 'usageLimitExceeded',
      },
      participant: {
        agentId: 'agent-codex',
        agentName: 'Codex',
        agentSlug: 'codex-cli-1',
        provider: 'openai',
        model: 'codex-max',
        modelPinned: true,
        supportsModelSwitch: true,
      },
      attemptedModels: [],
      attemptedAgents: [],
      availableAgents: [
        {
          agentId: 'agent-claude',
          agentName: 'Claude',
          agentSlug: 'claude-code-1',
          provider: 'anthropic',
        },
      ],
    });

    expect(decision).toMatchObject({
      type: 'switch_agent',
      agent: { agentId: 'agent-claude', agentSlug: 'claude-code-1' },
    });
  });

  it('returns terminal when no policy-triggered recovery path remains', async () => {
    const decision = await decideFallback({
      policy: { mode: 'model_only', preservePinnedModel: true },
      error: {
        category: 'usage_limit',
        summary: 'Usage limit reached',
        rawMessage: 'usageLimitExceeded',
      },
      participant: {
        agentId: 'agent-codex',
        agentName: 'Codex',
        agentSlug: 'codex-cli-1',
        provider: 'openai',
        model: 'codex-max',
        modelPinned: true,
        supportsModelSwitch: true,
      },
      attemptedModels: [],
      attemptedAgents: [],
      availableAgents: [],
    });

    expect(decision).toMatchObject({
      type: 'terminal',
      reason: 'usage_limit',
    });
    expect(decision.type === 'terminal' ? decision.message : '').toContain('pinned model');
  });
});

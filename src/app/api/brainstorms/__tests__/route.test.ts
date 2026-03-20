import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockCreateBrainstorm, mockListBrainstorms } = vi.hoisted(() => ({
  mockCreateBrainstorm: vi.fn(),
  mockListBrainstorms: vi.fn(),
}));

vi.mock('@/lib/services/brainstorm-service', () => ({
  createBrainstorm: mockCreateBrainstorm,
  listBrainstorms: mockListBrainstorms,
}));

import { POST } from '../route';

describe('POST /api/brainstorms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateBrainstorm.mockResolvedValue({ id: 'room-1' });
  });

  it('accepts and forwards the full shared brainstorm config contract', async () => {
    const req = new NextRequest('http://localhost/api/brainstorms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'Brainstorm',
        topic: 'Stabilize brainstorms',
        maxWaves: 12,
        config: {
          waveTimeoutSec: 180,
          wave0ExtraTimeoutSec: 240,
          convergenceMode: 'majority',
          minWavesBeforePass: 3,
          requiredObjections: 2,
          synthesisMode: 'validated',
          synthesisAgentId: '22222222-2222-4222-8222-222222222222',
          language: 'he',
          roles: { critic: 'codex-cli-1' },
          participantReadyTimeoutSec: 900,
          relatedRoomIds: ['33333333-3333-4333-8333-333333333333'],
          reactiveInjection: true,
          maxResponsesPerWave: 4,
          evictionThreshold: 3,
          roleInstructions: { critic: 'Push on correctness.' },
          reviewPauseSec: 30,
          goal: 'Produce a concrete stabilization plan',
          constraints: ['no regressions', 'preserve current UX'],
          deliverableType: 'exploration',
          targetAudience: 'core team',
          autoReflection: true,
          reflectionInterval: 4,
          fallback: {
            mode: 'model_then_agent',
            preservePinnedModel: true,
            triggerErrors: ['usage_limit', 'auth_error'],
          },
        },
        participants: [
          { agentId: '44444444-4444-4444-8444-444444444444', model: 'gpt-5.4' },
          { agentId: '55555555-5555-4555-8555-555555555555', model: 'sonnet' },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ data: { id: 'room-1' } });
    expect(mockCreateBrainstorm).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'Brainstorm',
        topic: 'Stabilize brainstorms',
        maxWaves: 12,
        config: expect.objectContaining({
          reactiveInjection: true,
          maxResponsesPerWave: 4,
          evictionThreshold: 3,
          roleInstructions: { critic: 'Push on correctness.' },
          reviewPauseSec: 30,
          goal: 'Produce a concrete stabilization plan',
          constraints: ['no regressions', 'preserve current UX'],
          deliverableType: 'exploration',
          targetAudience: 'core team',
          autoReflection: true,
          reflectionInterval: 4,
        }),
      }),
    );
  });
});

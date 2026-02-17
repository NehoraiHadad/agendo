import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch } from '../api-types';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  it('returns parsed data on 200 response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: '1', name: 'Agent' } }));

    const result = await apiFetch<{ data: { id: string; name: string } }>('/api/agents/1');

    expect(result).toEqual({ data: { id: '1', name: 'Agent' } });
  });

  it('throws Error with message from error body on 400', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: { code: 'BAD_REQUEST', message: 'Invalid agent ID' } }, 400),
    );

    await expect(apiFetch('/api/agents/bad')).rejects.toThrow('Invalid agent ID');
  });

  it('throws Error with fallback message when error body has no message', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: {} }, 500));

    await expect(apiFetch('/api/fail')).rejects.toThrow('Request failed');
  });

  it('sets Content-Type header by default', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: null }));

    await apiFetch('/api/test');

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers;
    expect(headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('merges custom headers over defaults', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: null }));

    await apiFetch('/api/test', {
      headers: { Authorization: 'Bearer token', 'Content-Type': 'text/plain' },
    });

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers;
    expect(headers).toHaveProperty('Authorization', 'Bearer token');
    // Custom Content-Type overrides default
    expect(headers).toHaveProperty('Content-Type', 'text/plain');
  });

  it('passes through other RequestInit options', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: null }));

    await apiFetch('/api/test', { method: 'POST', body: JSON.stringify({ x: 1 }) });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1]?.method).toBe('POST');
    expect(callArgs[1]?.body).toBe('{"x":1}');
  });
});

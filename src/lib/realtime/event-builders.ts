import type { AgendoEventPayload } from './events';

/**
 * Build an agent:tool-start event payload.
 */
export function buildToolStartEvent(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Extract<AgendoEventPayload, { type: 'agent:tool-start' }> {
  return { type: 'agent:tool-start', toolUseId, toolName, input };
}

/**
 * Build an agent:tool-end event payload.
 */
export function buildToolEndEvent(
  toolUseId: string,
  content: unknown,
): Extract<AgendoEventPayload, { type: 'agent:tool-end' }> {
  return { type: 'agent:tool-end', toolUseId, content };
}

/**
 * Build an error result as an array of event payloads.
 * Returns a single-element array with an agent:result error event.
 */
export function buildErrorResultEvent(
  message: string,
  subtype: string = 'error',
): AgendoEventPayload[] {
  return [
    {
      type: 'agent:result',
      costUsd: null,
      turns: null,
      durationMs: null,
      isError: true,
      subtype,
      errors: [message],
    },
  ];
}

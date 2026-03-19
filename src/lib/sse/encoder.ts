/**
 * Shared SSE event encoding utilities.
 *
 * Provides a single TextEncoder instance and helpers for formatting
 * events, named events, and heartbeat comments in the SSE wire format.
 */

export const encoder = new TextEncoder();

/**
 * Encode an SSE `data:` frame, optionally with an `id:` line.
 *
 * Output format:
 *   [id: <id>\n]
 *   data: <JSON>\n\n
 */
export function encodeSSE(data: unknown, id?: number | string): Uint8Array {
  let msg = '';
  if (id !== undefined) msg += `id: ${id}\n`;
  msg += `data: ${JSON.stringify(data)}\n\n`;
  return encoder.encode(msg);
}

/**
 * Encode an SSE `data:` frame with a named `event:` field.
 *
 * Output format:
 *   event: <event>\n
 *   data: <JSON>\n\n
 */
export function encodeNamedSSE(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Encode an SSE comment line (used as a keepalive/heartbeat).
 *
 * Output format:
 *   : heartbeat\n\n
 */
export function encodeHeartbeat(): Uint8Array {
  return encoder.encode(': heartbeat\n\n');
}

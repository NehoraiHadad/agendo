/**
 * Extract a human-readable message from an unknown caught value.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract a string message from any thrown value, including raw JSON-RPC error
 * objects `{ code, message }` that the ACP SDK rejects with (not Error instances).
 * Without this helper, `String(err)` on such objects produces "[object Object]".
 */
export function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

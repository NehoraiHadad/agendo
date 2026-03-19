/**
 * Append items to an array while enforcing a maximum window size.
 * When the combined array exceeds maxSize, the oldest items are trimmed.
 */
export function appendWithWindow<T>(
  existing: T[],
  incoming: T | T[],
  maxSize: number,
): { items: T[]; truncated: boolean } {
  const incomingArr = Array.isArray(incoming) ? incoming : [incoming];
  const combined = [...existing, ...incomingArr];
  if (combined.length > maxSize) {
    return { items: combined.slice(combined.length - maxSize), truncated: true };
  }
  return { items: combined, truncated: false };
}

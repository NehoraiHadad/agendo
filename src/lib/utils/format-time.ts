/** Common millisecond constants to replace magic numbers. */
export const MS = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
} as const;

/**
 * Format a timestamp as a short relative-time string (e.g. "3m ago", "2h ago").
 */
export function formatRelativeTime(timestamp: string | Date): string {
  try {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (diffMs < MS.MINUTE) return 'just now';
    if (diffMs < MS.HOUR) return `${Math.floor(diffMs / MS.MINUTE)}m ago`;
    if (diffMs < MS.DAY) return `${Math.floor(diffMs / MS.HOUR)}h ago`;
    return `${Math.floor(diffMs / MS.DAY)}d ago`;
  } catch {
    return '';
  }
}

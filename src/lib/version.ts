/**
 * Version utilities for Agendo.
 *
 * Version source of truth: package.json → NEXT_PUBLIC_APP_VERSION (build-time).
 * All functions accept optional `v` prefix (e.g. "v1.2.3" or "1.2.3").
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a semver string into its components.
 * Accepts optional `v` prefix. Returns null for invalid strings.
 */
export function parseVersion(version: string): SemVer | null {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Compare two semver strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal or if either is invalid.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;

  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;
  return 0;
}

/**
 * Check if `available` is a newer version than `current`.
 * Returns false for invalid inputs.
 */
export function isNewerVersion(available: string, current: string): boolean {
  return compareVersions(available, current) === 1;
}

/**
 * Get the current application version.
 * Reads from NEXT_PUBLIC_APP_VERSION (injected at build time via next.config.ts).
 * Falls back to '0.0.0' if not set.
 */
export function getCurrentVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
}

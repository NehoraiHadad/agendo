import { execFileSync } from 'child_process';

/** Returns the current git HEAD hash, or undefined if git is unavailable. */
export function getGitHead(): string | undefined {
  try {
    // Hardcoded args array — no shell interpolation, no injection risk.
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

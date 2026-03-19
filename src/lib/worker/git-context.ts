import { execFile } from 'child_process';

/**
 * Snapshot of git state for a working directory.
 * Defined locally for now — will be imported from event-types.ts later.
 */
export interface GitContextSnapshot {
  branch: string;
  commitHash: string;
  commitMessage: string;
  isDirty: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  isWorktree: boolean;
  worktreeMainPath?: string;
  baseBranch?: string;
  aheadBehind?: { ahead: number; behind: number };
}

const GIT_TIMEOUT_MS = 5000;

/**
 * Run a git command safely with execFile and a 5s timeout.
 * Returns stdout trimmed, or null if the command fails.
 * Use raw=true to preserve leading whitespace (needed for porcelain output).
 */
function gitExec(args: string[], cwd: string, raw = false): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null);
      } else {
        const output = String(stdout);
        resolve(raw ? output.trimEnd() : output.trim());
      }
    });
  });
}

/**
 * Parse `git status --porcelain` output into staged/modified/untracked arrays.
 */
function parseStatusPorcelain(output: string): {
  staged: string[];
  modified: string[];
  untracked: string[];
} {
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  if (!output) return { staged, modified, untracked };

  for (const line of output.split('\n')) {
    if (line.length < 3) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3);

    // Untracked
    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push(filePath);
      continue;
    }

    // Staged (index has A, M, D, R, C)
    if (
      indexStatus === 'A' ||
      indexStatus === 'M' ||
      indexStatus === 'D' ||
      indexStatus === 'R' ||
      indexStatus === 'C'
    ) {
      staged.push(filePath);
    }

    // Modified in working tree
    if (workTreeStatus === 'M' || workTreeStatus === 'D') {
      modified.push(filePath);
    }
  }

  return { staged, modified, untracked };
}

/**
 * Capture git context from a working directory.
 * Returns null if the directory is not a git repo.
 */
export async function captureGitContext(cwd: string): Promise<GitContextSnapshot | null> {
  // Run the first 6 commands in parallel
  const [branch, commitHash, commitMessage, statusOutput, gitCommonDir, upstream] =
    await Promise.all([
      gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      gitExec(['rev-parse', '--short', 'HEAD'], cwd),
      gitExec(['log', '-1', '--format=%s'], cwd),
      gitExec(['status', '--porcelain'], cwd, true),
      gitExec(['rev-parse', '--git-common-dir'], cwd),
      gitExec(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd),
    ]);

  // If basic commands fail, this is not a git repo
  if (branch === null || commitHash === null) {
    return null;
  }

  const { staged, modified, untracked } = parseStatusPorcelain(statusOutput ?? '');

  // Worktree detection: if git-common-dir is not '.git', it's a worktree
  const isWorktree = gitCommonDir !== null && gitCommonDir !== '.git';
  const worktreeMainPath = isWorktree ? gitCommonDir : undefined;

  // Ahead/behind — only if upstream exists
  let aheadBehind: { ahead: number; behind: number } | undefined;
  let baseBranch: string | undefined;

  if (upstream !== null) {
    baseBranch = upstream;
    const [aheadStr, behindStr] = await Promise.all([
      gitExec(['rev-list', '--count', '@{upstream}..HEAD'], cwd),
      gitExec(['rev-list', '--count', 'HEAD..@{upstream}'], cwd),
    ]);

    if (aheadStr !== null && behindStr !== null) {
      aheadBehind = {
        ahead: parseInt(aheadStr, 10) || 0,
        behind: parseInt(behindStr, 10) || 0,
      };
    }
  }

  return {
    branch,
    commitHash,
    commitMessage: commitMessage ?? '',
    isDirty: staged.length > 0 || modified.length > 0 || untracked.length > 0,
    staged,
    modified,
    untracked,
    isWorktree,
    worktreeMainPath,
    baseBranch,
    aheadBehind,
  };
}

/**
 * Count commits between two refs using `git rev-list --count`.
 * Returns 0 if the command fails or either ref is invalid.
 */
export async function countCommitsSince(fromHash: string, cwd: string): Promise<number> {
  const result = await gitExec(['rev-list', '--count', `${fromHash}..HEAD`], cwd);
  if (result === null) return 0;
  return parseInt(result, 10) || 0;
}

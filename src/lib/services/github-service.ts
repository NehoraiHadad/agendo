import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { createLogger } from '@/lib/logger';

const log = createLogger('github-service');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  fullName: string; // "owner/repo"
}

export interface GitHubTokenInfo {
  token: string;
  source: 'env' | 'gh-cli';
  username?: string;
}

// ---------------------------------------------------------------------------
// Auth cascade (cached in memory)
// ---------------------------------------------------------------------------

let cachedToken: GitHubTokenInfo | null | undefined; // undefined = not yet resolved

/**
 * Resolve a GitHub token using the cascade:
 * 1. process.env.GITHUB_TOKEN
 * 2. `gh auth token` shell command
 * 3. null (no token available)
 *
 * Result is cached for the process lifetime. Call `clearTokenCache()` to reset.
 */
export async function getGitHubToken(): Promise<GitHubTokenInfo | null> {
  if (cachedToken !== undefined) return cachedToken;

  // 1. Environment variable
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    log.info('GitHub token found via GITHUB_TOKEN env var');
    const info = await validateToken(envToken, 'env');
    cachedToken = info;
    return cachedToken;
  }

  // 2. gh CLI
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5000,
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
    });
    const token = stdout.trim();
    if (token) {
      log.info('GitHub token found via gh CLI');
      const info = await validateToken(token, 'gh-cli');
      cachedToken = info;
      return cachedToken;
    }
  } catch {
    log.debug('gh CLI not available or not authenticated');
  }

  // 3. No token
  log.warn('No GitHub token available (set GITHUB_TOKEN or install gh CLI)');
  cachedToken = null;
  return null;
}

/**
 * Validate a token with the GitHub API and return token info.
 * Returns null if the token is invalid.
 */
async function validateToken(
  token: string,
  source: 'env' | 'gh-cli',
): Promise<GitHubTokenInfo | null> {
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.users.getAuthenticated();
    log.info({ username: data.login, source }, 'GitHub token validated');
    return { token, source, username: data.login };
  } catch (err) {
    log.warn({ err, source }, 'GitHub token validation failed');
    return null;
  }
}

/** Clear the cached token (useful for testing or after env changes). */
export function clearTokenCache(): void {
  cachedToken = undefined;
}

/**
 * Get an authenticated Octokit instance, or null if no token is available.
 */
export async function getOctokit(): Promise<Octokit | null> {
  const tokenInfo = await getGitHubToken();
  if (!tokenInfo) return null;
  return new Octokit({ auth: tokenInfo.token });
}

// ---------------------------------------------------------------------------
// Repo detection from git remotes
// ---------------------------------------------------------------------------

// Match HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
const HTTPS_PATTERN = /https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/;
// Match SSH: git@github.com:owner/repo.git or git@github.com:owner/repo
const SSH_PATTERN = /git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/;

/**
 * Parse a git remote URL into owner/repo if it's a GitHub remote.
 * Returns null for non-GitHub remotes.
 */
export function parseGitHubRemoteUrl(url: string): GitHubRepoInfo | null {
  const httpsMatch = url.match(HTTPS_PATTERN);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      fullName: `${httpsMatch[1]}/${httpsMatch[2]}`,
    };
  }

  const sshMatch = url.match(SSH_PATTERN);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      fullName: `${sshMatch[1]}/${sshMatch[2]}`,
    };
  }

  return null;
}

/**
 * Auto-detect a GitHub repository from the git remotes in a directory.
 * Prefers the `origin` remote. Returns null if no GitHub remote found.
 */
export async function detectGitHubRepo(rootPath: string): Promise<GitHubRepoInfo | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', '-v'], {
      cwd: rootPath,
      timeout: 5000,
    });

    const lines = stdout.trim().split('\n');
    if (lines.length === 0 || !lines[0]) return null;

    // Parse all remotes: "name\turl (fetch|push)"
    const remotes = new Map<string, string>();
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
      if (match) {
        remotes.set(match[1], match[2]);
      }
    }

    // Prefer 'origin', then first remote that's on GitHub
    const originUrl = remotes.get('origin');
    if (originUrl) {
      const info = parseGitHubRemoteUrl(originUrl);
      if (info) {
        log.info({ rootPath, repo: info.fullName }, 'Detected GitHub repo from origin');
        return info;
      }
    }

    // Fall back to any GitHub remote
    for (const [name, url] of remotes) {
      const info = parseGitHubRemoteUrl(url);
      if (info) {
        log.info({ rootPath, remote: name, repo: info.fullName }, 'Detected GitHub repo');
        return info;
      }
    }

    return null;
  } catch {
    // Not a git repo or git not installed
    log.debug({ rootPath }, 'No git repo detected');
    return null;
  }
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface OAuthProvider {
  /** Provider id passed to `-p` flag */
  provider: string;
  /** Display label in the UI */
  label: string;
  /** Login method passed to `-m` flag (skips method picker) */
  method: string;
  /** 'oauth' = URL flow, 'api-key' = piped stdin key entry */
  type: 'oauth' | 'api-key';
}

interface AuthConfig {
  envVars: string[];
  credentialPaths: string[];
  authCommand: string;
  homepage: string;
  displayName: string;
  /** If set, CLI Login tab shows a provider picker instead of a single button */
  oauthProviders?: OAuthProvider[];
  /** If true, the CLI has no `auth login` subcommand — auth happens on first interactive run */
  noCliAuth?: boolean;
}

export interface AuthStatusResult {
  hasEnvKey: boolean;
  hasCredentialFile: boolean;
  isAuthenticated: boolean;
  method: 'env-var' | 'credential-file' | 'both' | 'none';
  envVarDetails: Array<{ name: string; isSet: boolean }>;
  authCommand: string;
  homepage: string;
  displayName: string;
  /** If set, CLI Login tab shows a provider picker (for multi-provider agents like OpenCode) */
  oauthProviders: OAuthProvider[];
  /** If true, CLI Login tab is not available — agent authenticates on first interactive run */
  noCliAuth: boolean;
}

export interface SpawnAuthResult {
  process: ChildProcess;
}

/**
 * In-memory registry of running auth processes keyed by agentId.
 * Used to pipe stdin input (e.g. authorization codes) back to the process.
 */
const runningAuthProcesses = new Map<string, ChildProcess>();

export function getRunningAuthProcess(agentId: string): ChildProcess | undefined {
  return runningAuthProcesses.get(agentId);
}

export function setRunningAuthProcess(agentId: string, proc: ChildProcess): void {
  // Kill any existing process for this agent
  const existing = runningAuthProcesses.get(agentId);
  if (existing && !existing.killed) {
    existing.kill();
  }
  runningAuthProcesses.set(agentId, proc);
  proc.on('exit', () => runningAuthProcesses.delete(agentId));
}

const AUTH_REGISTRY: Record<string, AuthConfig> = {
  claude: {
    envVars: ['ANTHROPIC_API_KEY'],
    credentialPaths: [
      path.join(os.homedir(), '.claude', 'credentials.json'),
      path.join(os.homedir(), '.claude', '.credentials.json'),
    ],
    authCommand: 'claude auth login',
    homepage: 'https://claude.ai',
    displayName: 'Claude Code',
  },
  codex: {
    envVars: ['OPENAI_API_KEY'],
    credentialPaths: [path.join(os.homedir(), '.codex', 'auth.json')],
    authCommand: 'codex auth login',
    homepage: 'https://openai.com/codex',
    displayName: 'Codex CLI',
  },
  gemini: {
    envVars: ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    credentialPaths: [
      path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
      path.join(os.homedir(), '.gemini', 'google_accounts.json'),
    ],
    authCommand: 'gemini',
    homepage: 'https://ai.google.dev',
    displayName: 'Gemini CLI',
    noCliAuth: true, // Gemini has no `auth login` — it authenticates via browser on first interactive run
  },
  copilot: {
    envVars: ['GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN'],
    credentialPaths: [
      path.join(os.homedir(), '.config', 'gh', 'hosts.yml'),
      path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json'),
    ],
    authCommand: 'gh auth login --web',
    homepage: 'https://github.com/features/copilot',
    displayName: 'GitHub Copilot CLI',
  },
  opencode: {
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
    // opencode.db always exists (skeleton DB) — no reliable credential file detection.
    // Auth is only detectable via env vars.
    credentialPaths: [],
    authCommand: 'opencode auth login',
    homepage: 'https://opencode.ai',
    displayName: 'OpenCode',
    oauthProviders: [
      {
        provider: 'anthropic',
        label: 'Anthropic (Claude Pro/Max)',
        method: 'Claude Pro/Max',
        type: 'oauth',
      },
      {
        provider: 'openai',
        label: 'OpenAI (ChatGPT Pro/Plus)',
        method: 'ChatGPT Pro/Plus (headless)',
        type: 'oauth',
      },
      {
        provider: 'OpenCode Zen',
        label: 'OpenCode Zen',
        method: 'Create an api key',
        type: 'oauth',
      },
    ],
  },
};

export function getAuthConfig(binaryName: string): AuthConfig | null {
  return AUTH_REGISTRY[binaryName] ?? null;
}

/** Read the agendo-worker env block from ecosystem.config.js */
function readWorkerEnvFromEcosystem(): Record<string, string> {
  const ecosystemPath = path.resolve(os.homedir(), 'projects', 'ecosystem.config.js');
  const content = fs.readFileSync(ecosystemPath, 'utf-8');

  const moduleObj: {
    exports: { apps?: Array<{ name: string; env?: Record<string, string> }> };
  } = { exports: {} };

  // Replace module.exports with a local variable assignment for safe eval
  const wrapped = content.replace('module.exports', 'moduleObj.exports');
  new Function('moduleObj', wrapped)(moduleObj);

  const apps = moduleObj.exports.apps ?? [];
  const workerApp = apps.find((app) => app.name === 'agendo-worker');
  return workerApp?.env ?? {};
}

/**
 * Returns a map of env var name -> whether it's set in ecosystem.config.js for agendo-worker.
 * NEVER returns actual values — existence checks only.
 */
export function getWorkerEnvVars(): Record<string, boolean> {
  const env = readWorkerEnvFromEcosystem();
  return Object.fromEntries(Object.entries(env).map(([key, val]) => [key, !!val]));
}

export function checkAuthStatus(binaryName: string): AuthStatusResult {
  const config = getAuthConfig(binaryName);
  if (!config) {
    return {
      hasEnvKey: false,
      hasCredentialFile: false,
      isAuthenticated: false,
      method: 'none',
      envVarDetails: [],
      authCommand: '',
      homepage: '',
      displayName: binaryName,
      oauthProviders: [],
      noCliAuth: false,
    };
  }

  const workerEnv = readWorkerEnvFromEcosystem();

  const envVarDetails = config.envVars.map((name) => ({
    name,
    isSet: !!(process.env[name] ?? workerEnv[name]),
  }));

  const hasEnvKey = envVarDetails.some((v) => v.isSet);
  const hasCredentialFile = config.credentialPaths.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  let method: AuthStatusResult['method'];
  if (hasEnvKey && hasCredentialFile) {
    method = 'both';
  } else if (hasEnvKey) {
    method = 'env-var';
  } else if (hasCredentialFile) {
    method = 'credential-file';
  } else {
    method = 'none';
  }

  return {
    hasEnvKey,
    hasCredentialFile,
    isAuthenticated: hasEnvKey || hasCredentialFile,
    method,
    envVarDetails,
    authCommand: config.authCommand,
    homepage: config.homepage,
    displayName: config.displayName,
    oauthProviders: config.oauthProviders ?? [],
    noCliAuth: config.noCliAuth ?? false,
  };
}

/**
 * Write an env var to the agendo-worker app in ecosystem.config.js and restart the worker.
 * NEVER restarts `agendo` — only `agendo-worker`.
 */
export async function writeEnvVarToEcosystem(envVar: string, value: string): Promise<void> {
  const ecosystemPath = path.resolve(os.homedir(), 'projects', 'ecosystem.config.js');
  let content = fs.readFileSync(ecosystemPath, 'utf-8');

  // Escape the value for insertion into JS source
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Try to update an existing key within the agendo-worker env block
  const updateRegex = new RegExp(
    `(name:\\s*['"]agendo-worker['"][\\s\\S]*?env:\\s*\\{[\\s\\S]*?)${envVar}:\\s*['"][^'"]*['"]`,
  );

  if (updateRegex.test(content)) {
    content = content.replace(updateRegex, `$1${envVar}: '${escaped}'`);
  } else {
    // Insert the new key at the start of the agendo-worker env block
    const insertRegex = /(name:\s*['"]agendo-worker['"][\s\S]*?env:\s*\{)/;
    if (!insertRegex.test(content)) {
      throw new Error('Could not find agendo-worker env block in ecosystem.config.js');
    }
    content = content.replace(insertRegex, `$1\n        ${envVar}: '${escaped}',`);
  }

  fs.writeFileSync(ecosystemPath, content, 'utf-8');

  // Restart only the worker — hardcoded command, no user input, safe from injection
  execSync('pm2 restart agendo-worker --update-env', { stdio: 'pipe' });
}

/**
 * Spawn the CLI auth process. Returns the ChildProcess so the caller can stream stdout/stderr.
 */
export function spawnAuthProcess(authCommand: string): SpawnAuthResult {
  const [cmd, ...args] = authCommand.split(' ');
  const proc = spawn(cmd, args, {
    shell: true,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { process: proc };
}

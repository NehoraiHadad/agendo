import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

interface AuthConfig {
  envVars: string[];
  credentialPaths: string[];
  authCommand: string;
  homepage: string;
  displayName: string;
  /** If true, the auth CLI requires interactive TUI input and can't run headlessly */
  interactive?: boolean;
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
  /** If true, CLI auth requires interactive TUI — headless OAuth flow is unavailable */
  interactive: boolean;
}

export interface SpawnAuthResult {
  process: ChildProcess;
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
    authCommand: 'gemini auth login',
    homepage: 'https://ai.google.dev',
    displayName: 'Gemini CLI',
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
    interactive: true, // TUI provider picker — can't run headlessly
  },
};

export function getAuthConfig(binaryName: string): AuthConfig | null {
  return AUTH_REGISTRY[binaryName] ?? null;
}

/** Read the agendo-worker env block from ecosystem.config.js */
function readWorkerEnvFromEcosystem(): Record<string, string> {
  const ecosystemPath = '/home/ubuntu/projects/ecosystem.config.js';
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
      interactive: false,
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
    interactive: config.interactive ?? false,
  };
}

/**
 * Write an env var to the agendo-worker app in ecosystem.config.js and restart the worker.
 * NEVER restarts `agendo` — only `agendo-worker`.
 */
export async function writeEnvVarToEcosystem(envVar: string, value: string): Promise<void> {
  const ecosystemPath = '/home/ubuntu/projects/ecosystem.config.js';
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

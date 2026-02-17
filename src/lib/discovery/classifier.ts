import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ToolType =
  | 'cli-tool'
  | 'ai-agent'
  | 'daemon'
  | 'interactive-tui'
  | 'shell-util'
  | 'admin-tool';

/** Known AI agent binary names */
const AI_AGENT_NAMES = new Set([
  'claude',
  'gemini',
  'codex',
  'cursor-agent',
  'openai',
  'aichat',
  'ollama',
  'grok',
  'copilot',
  'adk',
  'tiny-agents',
]);

/** Known interactive TUI tools */
const TUI_TOOLS = new Set([
  'vim',
  'nvim',
  'nano',
  'emacs',
  'htop',
  'top',
  'btop',
  'tmux',
  'screen',
  'less',
  'more',
  'mc',
]);

/** Known shell utilities */
const SHELL_UTILS = new Set([
  'ls',
  'cat',
  'grep',
  'find',
  'sort',
  'awk',
  'sed',
  'tr',
  'cut',
  'wc',
  'head',
  'tail',
  'cp',
  'mv',
  'rm',
  'mkdir',
  'chmod',
  'chown',
  'echo',
  'printf',
  'test',
  'true',
  'false',
  'env',
  'pwd',
  'cd',
  'basename',
  'dirname',
  'readlink',
  'tee',
  'xargs',
  'uniq',
  'comm',
  'diff',
  'patch',
]);

export interface ClassificationInput {
  name: string;
  packageSection: string | null;
}

/**
 * Classify a binary using multiple heuristics.
 */
export async function classifyBinary(input: ClassificationInput): Promise<ToolType> {
  const { name, packageSection } = input;

  if (AI_AGENT_NAMES.has(name)) return 'ai-agent';
  if (TUI_TOOLS.has(name)) return 'interactive-tui';
  if (SHELL_UTILS.has(name)) return 'shell-util';

  const isService = await isSystemdService(name);
  if (isService) return 'daemon';

  const manSection = await getManSection(name);
  if (manSection === 8) return 'admin-tool';

  if (name.endsWith('d') && name.length > 3) {
    if (packageSection === 'admin' || packageSection === 'net') return 'daemon';
  }

  if (name.includes('ctl')) return 'admin-tool';

  return 'cli-tool';
}

async function getManSection(binaryName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('man', ['-w', binaryName], {
      timeout: 5000,
    });
    const match = stdout.match(/man(\d)\//);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

async function isSystemdService(binaryName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['list-unit-files', '--type=service', '--no-pager'],
      { timeout: 5000 },
    );
    const pattern = new RegExp(`\\b${binaryName.toLowerCase()}\\.service\\b`);
    return pattern.test(stdout.toLowerCase());
  } catch {
    return false;
  }
}

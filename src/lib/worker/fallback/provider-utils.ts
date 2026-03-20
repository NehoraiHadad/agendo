import { basename } from 'node:path';
import type { Provider } from '@/lib/services/model-service';

export function binaryNameToProvider(name: string): Provider | null {
  if (name === 'claude') return 'anthropic';
  if (name === 'codex') return 'openai';
  if (name === 'gemini') return 'google';
  if (name === 'copilot') return 'github';
  return null;
}

export function binaryPathToProvider(binaryPath: string): Provider | null {
  const binaryName = basename(binaryPath).replace(/\.exe$/i, '');
  return binaryNameToProvider(binaryName);
}

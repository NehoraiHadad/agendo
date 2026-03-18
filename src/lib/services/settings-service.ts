/**
 * Simple key-value settings persistence via a JSON config file.
 *
 * Settings are stored at /data/agendo/settings.json (same directory as logs, memory, etc.).
 * No database migration needed — just a file on disk.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@/lib/logger';
import type { AiProvider } from './ai-call';

const log = createLogger('settings-service');

export const SETTINGS_PATH = '/data/agendo/settings.json';

type AiProviderPreference = AiProvider | 'auto';

const VALID_AI_PROVIDERS: readonly AiProviderPreference[] = [
  'auto',
  'anthropic',
  'openai',
  'gemini',
] as const;

// ─── Generic key-value get/set ──────────────────────────────────

function readSettingsFile(): Record<string, unknown> {
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getSetting(key: string): unknown {
  const settings = readSettingsFile();
  return settings[key];
}

export function setSetting(key: string, value: unknown): void {
  const settings = readSettingsFile();
  settings[key] = value;

  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  log.info({ key }, 'Setting updated');
}

// ─── AI Provider preference ─────────────────────────────────────

export function getAiProviderPreference(): AiProviderPreference {
  const value = getSetting('ai_provider_preference');
  if (typeof value === 'string' && VALID_AI_PROVIDERS.includes(value as AiProviderPreference)) {
    return value as AiProviderPreference;
  }
  return 'auto';
}

export function setAiProviderPreference(provider: AiProviderPreference): void {
  if (!VALID_AI_PROVIDERS.includes(provider)) {
    throw new Error(
      `Invalid AI provider preference: ${provider}. Must be one of: ${VALID_AI_PROVIDERS.join(', ')}`,
    );
  }
  setSetting('ai_provider_preference', provider);
}

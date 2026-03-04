import type { ComponentType } from 'react';

// ---------------------------------------------------------------------------
// Permission mode
// ---------------------------------------------------------------------------

export type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';

export const MODE_CYCLE: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

export interface ModeConfigEntry {
  label: string;
  icon: ComponentType<{ className?: string }>;
  className: string;
  title: string;
}

// NOTE: MODE_CONFIG is defined in the consuming components because it references
// lucide-react icons (client-side dependency). Use buildModeConfig() to construct it.

export function nextMode(current: PermissionMode): PermissionMode {
  const idx = MODE_CYCLE.indexOf(current);
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

export interface DynamicModelOption {
  id: string;
  label: string;
}

/** Extract a short human-readable label from a model ID string.
 *  e.g. "claude-sonnet-4-5-20250514" -> "Sonnet 4.5" */
export function modelDisplayLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  const families = ['opus', 'sonnet', 'haiku'];
  for (const fam of families) {
    const idx = lower.indexOf(fam);
    if (idx !== -1) {
      const rest = lower.slice(idx + fam.length).replace(/^-/, '');
      const versionMatch = rest.match(/^(\d+)[.-](\d+)/);
      const version = versionMatch ? ` ${versionMatch[1]}.${versionMatch[2]}` : '';
      return fam.charAt(0).toUpperCase() + fam.slice(1) + version;
    }
  }
  return modelId.replace(/^claude-/, '');
}

/** Derive provider name from binary path for model API queries. */
export function deriveProvider(binaryPath: string): string {
  const base = binaryPath.split('/').pop()?.toLowerCase() ?? '';
  if (base.startsWith('claude')) return 'claude';
  if (base.startsWith('codex')) return 'codex';
  if (base.startsWith('gemini')) return 'gemini';
  return 'claude';
}

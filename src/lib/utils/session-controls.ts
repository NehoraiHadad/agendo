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
  /** Whether this model is the CLI's default when no --model flag is passed. */
  isDefault?: boolean;
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

/**
 * Check if a picker model option matches the current active model.
 *
 * Matching strategy:
 * 1. Exact ID match — works for all providers where IDs are real model IDs
 * 2. isDefault fallback — when the active model is a full ID (e.g. "claude-opus-4-6[1m]")
 *    that doesn't match any alias, the default picker entry is the match
 *    (since the CLI defaults to its default model when no --model flag was passed)
 *
 * After a user switches models, currentModel becomes the alias itself
 * (e.g. "sonnet") via the "Model switched to" event, so exact match works.
 */
export function isModelMatch(
  pickerId: string,
  _pickerLabel: string,
  activeModelId: string | null,
  pickerIsDefault?: boolean,
  allPickerIds?: string[],
): boolean {
  if (!activeModelId) return false;

  // Exact ID match
  if (activeModelId.toLowerCase() === pickerId.toLowerCase()) return true;

  // If the active model doesn't match ANY picker ID exactly, it's a full ID
  // reported by session:init (e.g. "claude-opus-4-6[1m]"). In that case,
  // the default picker entry is the current model.
  if (pickerIsDefault && allPickerIds) {
    const hasExactMatch = allPickerIds.some(
      (id) => id.toLowerCase() === activeModelId.toLowerCase(),
    );
    if (!hasExactMatch) return true;
  }

  return false;
}

/** Derive provider name from binary path for model API queries. */
export function deriveProvider(binaryPath: string): string {
  const base = binaryPath.split('/').pop()?.toLowerCase() ?? '';
  if (base.startsWith('claude')) return 'claude';
  if (base.startsWith('codex')) return 'codex';
  if (base.startsWith('gemini')) return 'gemini';
  if (base.startsWith('copilot')) return 'copilot';
  return 'claude';
}

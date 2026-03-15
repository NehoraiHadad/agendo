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
 * Claude SDK returns aliases ("default", "sonnet", "haiku") while session:init
 * reports full IDs ("claude-opus-4-6[1m]"). We match by:
 * 1. Exact match (same ID)
 * 2. The picker label matches the family extracted from the active model
 *    (e.g. picker label "Opus 4.6" matches active "claude-opus-4-6[1m]")
 */
export function isModelMatch(
  pickerId: string,
  pickerLabel: string,
  activeModelId: string | null,
): boolean {
  if (!activeModelId) return false;
  const aLower = activeModelId.toLowerCase();
  const pLower = pickerId.toLowerCase();

  // Exact ID match
  if (aLower === pLower) return true;

  // Derive short label from active model ("claude-opus-4-6[1m]" → "Opus 4.6")
  const activeLabel = modelDisplayLabel(activeModelId).toLowerCase();
  const pLabel = pickerLabel.toLowerCase();

  // Label match (e.g. both are "opus 4.6")
  if (activeLabel && pLabel && activeLabel === pLabel) return true;

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

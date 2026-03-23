'use client';

import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { useFetch } from '@/hooks/use-fetch';
import type { ModelOption } from '@/lib/services/model-service';

export type { ModelOption };

interface ModelPickerPopoverProps {
  onSelect: (modelId: string) => void;
  onClose: () => void;
  /** Provider name derived from agent binaryPath (e.g. "claude", "codex", "gemini"). */
  provider?: string | null;
}

/** Group models by family for providers that benefit from it (e.g. Gemini). */
interface ModelGroup {
  label: string | null; // null = ungrouped
  models: ModelOption[];
}

function groupGeminiModels(models: ModelOption[]): ModelGroup[] {
  const auto: ModelOption[] = [];
  const gen3: ModelOption[] = [];
  const gen25: ModelOption[] = [];
  const other: ModelOption[] = [];

  for (const m of models) {
    if (m.id.startsWith('auto')) {
      auto.push(m);
    } else if (/gemini-3(\.|\b)/.test(m.id)) {
      gen3.push(m);
    } else if (/gemini-2\.5/.test(m.id)) {
      gen25.push(m);
    } else {
      other.push(m);
    }
  }

  const groups: ModelGroup[] = [];
  if (auto.length > 0) groups.push({ label: 'Auto', models: auto });
  if (gen3.length > 0) groups.push({ label: 'Gemini 3', models: gen3 });
  if (gen25.length > 0) groups.push({ label: 'Gemini 2.5', models: gen25 });
  if (other.length > 0) groups.push({ label: null, models: other });
  return groups;
}

function isPreviewDescription(desc: string): boolean {
  return /preview/i.test(desc);
}

export function ModelPickerPopover({ onSelect, onClose, provider }: ModelPickerPopoverProps) {
  const resolvedProvider = provider ?? 'claude';
  const { data: models, isLoading } = useFetch<ModelOption[]>(
    `/api/models?provider=${encodeURIComponent(resolvedProvider)}`,
    {
      deps: [resolvedProvider],
      transform: (json: unknown) => (json as { data: ModelOption[] })?.data ?? [],
    },
  );

  const isGemini = resolvedProvider === 'gemini' || resolvedProvider === 'google';

  const groups = useMemo<ModelGroup[]>(() => {
    if (!models || models.length === 0) return [];
    if (isGemini) return groupGeminiModels(models);
    return [{ label: null, models }];
  }, [models, isGemini]);

  const renderModel = (model: ModelOption) => (
    <li
      key={model.id}
      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/[0.06] transition-colors"
      onClick={() => {
        onSelect(model.id);
        onClose();
      }}
    >
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="text-xs font-medium text-foreground">{model.label}</span>
        {model.isDefault && (
          <span className="shrink-0 text-[9px] px-1 py-px rounded bg-white/[0.08] text-muted-foreground/60 font-medium">
            default
          </span>
        )}
        {isPreviewDescription(model.description) && (
          <span className="shrink-0 text-[9px] px-1 py-px rounded bg-amber-500/10 text-amber-400/70 font-medium">
            preview
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/40 truncate">
          {model.description}
        </span>
      </div>
    </li>
  );

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border border-white/[0.10] bg-[oklch(0.10_0_0)] shadow-2xl overflow-hidden">
      <div className="px-3 py-1.5 border-b border-white/[0.06]">
        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">
          Switch model · click to select
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-6">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/40">Loading models…</span>
        </div>
      ) : groups.length === 0 ? (
        <div className="px-3 py-4 text-center">
          <span className="text-xs text-muted-foreground/50">No models available.</span>
        </div>
      ) : (
        <ul className="py-1 max-h-64 overflow-y-auto">
          {groups.map((group, gi) => (
            <li key={group.label ?? `group-${gi}`}>
              {group.label && (
                <div className="px-3 pt-2 pb-1 first:pt-1">
                  <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider font-medium">
                    {group.label}
                  </span>
                </div>
              )}
              <ul>{group.models.map(renderModel)}</ul>
            </li>
          ))}
        </ul>
      )}

      <div className="px-3 py-1.5 border-t border-white/[0.06]">
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

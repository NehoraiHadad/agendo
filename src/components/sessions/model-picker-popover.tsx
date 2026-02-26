'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface ModelPickerPopoverProps {
  onSelect: (modelId: string) => void;
  onClose: () => void;
  /** Provider name derived from agent binaryPath (e.g. "claude", "codex", "gemini"). */
  provider?: string | null;
}

export function ModelPickerPopover({ onSelect, onClose, provider }: ModelPickerPopoverProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const resolvedProvider = provider ?? 'claude';
    const controller = new AbortController();

    fetch(`/api/models?provider=${encodeURIComponent(resolvedProvider)}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ data: ModelOption[] }>) : null))
      .then((body) => {
        if (!controller.signal.aborted) setModels(body?.data ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setModels([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [provider]);

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
      ) : models.length === 0 ? (
        <div className="px-3 py-4 text-center">
          <span className="text-xs text-muted-foreground/50">No models available.</span>
        </div>
      ) : (
        <ul className="py-1 max-h-64 overflow-y-auto">
          {models.map((model) => (
            <li
              key={model.id}
              className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/[0.06] transition-colors"
              onClick={() => {
                onSelect(model.id);
                onClose();
              }}
            >
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-foreground">{model.label}</span>
                <span className="ml-2 text-[10px] text-muted-foreground/50 truncate">
                  {model.description}
                </span>
              </div>
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

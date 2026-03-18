'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Sparkles, Check, Info } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type AiProviderPreference = 'auto' | 'anthropic' | 'openai' | 'gemini';

/** Three possible states for each provider in this context */
type ProviderState = 'available' | 'cli-only' | 'unavailable';

interface ProviderOption {
  value: AiProviderPreference;
  label: string;
  description: string;
  state: ProviderState;
}

const PROVIDER_META: Record<
  AiProviderPreference,
  { label: string; description: string; color?: string }
> = {
  auto: {
    label: 'Auto',
    description: 'Use first available provider (Anthropic > OpenAI > Gemini)',
  },
  anthropic: {
    label: 'Anthropic',
    description: 'Prefer Claude for AI calls',
    color: 'oklch(0.7 0.18 280)',
  },
  openai: {
    label: 'OpenAI',
    description: 'Prefer GPT models for AI calls',
    color: 'oklch(0.65 0.15 140)',
  },
  gemini: {
    label: 'Gemini',
    description: 'Prefer Gemini for AI calls',
    color: 'oklch(0.7 0.15 55)',
  },
};

function StateIndicator({ state }: { state: ProviderState }) {
  switch (state) {
    case 'available':
      return (
        <span
          className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
          style={{
            color: 'oklch(0.72 0.15 155)',
            background: 'oklch(0.72 0.15 155 / 0.1)',
          }}
        >
          <span className="h-1 w-1 rounded-full bg-current" />
          Ready
        </span>
      );
    case 'cli-only':
      return (
        <span
          className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
          style={{
            color: 'oklch(0.75 0.15 70)',
            background: 'oklch(0.75 0.15 70 / 0.08)',
          }}
        >
          <Info className="h-2.5 w-2.5" />
          CLI only
        </span>
      );
    case 'unavailable':
      return (
        <span className="text-[10px] text-muted-foreground/25 font-medium">Not configured</span>
      );
  }
}

export function AiProviderPreference() {
  const [preference, setPreference] = useState<AiProviderPreference>('auto');
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [cliOnlyProviders, setCliOnlyProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/ai-provider');
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'Failed to load preference');
        return;
      }
      const body = (await res.json()) as {
        data: {
          preference: AiProviderPreference;
          availableProviders: string[];
          cliOnlyProviders?: string[];
        };
      };
      setPreference(body.data.preference);
      setAvailableProviders(body.data.availableProviders);
      setCliOnlyProviders(body.data.cliOnlyProviders ?? []);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleChange(value: string) {
    const newPref = value as AiProviderPreference;
    setPreference(newPref);
    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      const res = await fetch('/api/settings/ai-provider', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: newPref }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'Failed to save preference');
        return;
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  function getProviderState(value: AiProviderPreference): ProviderState {
    if (value === 'auto') return 'available';
    if (availableProviders.includes(value)) return 'available';
    if (cliOnlyProviders.includes(value)) return 'cli-only';
    return 'unavailable';
  }

  const options: ProviderOption[] = (['auto', 'anthropic', 'openai', 'gemini'] as const).map(
    (value) => ({
      value,
      label: PROVIDER_META[value].label,
      description: PROVIDER_META[value].description,
      state: getProviderState(value),
    }),
  );

  const hasCliOnly = cliOnlyProviders.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-primary/60" />
          <span className="text-[13px] font-medium text-foreground/80">
            AI Provider for Internal Calls
          </span>
        </div>
        {saved && (
          <div className="flex items-center gap-1 text-emerald-400/70">
            <Check className="h-3 w-3" />
            <span className="text-[11px]">Saved</span>
          </div>
        )}
        {saving && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground/40" />}
      </div>

      <p className="text-[12px] text-muted-foreground/50 leading-relaxed">
        Choose which AI provider Agendo uses for internal features like changelog summaries,
        auto-tagging, and smart search. Fallback to other providers still works if the preferred one
        fails.
      </p>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20">
          <span className="text-[12px] text-destructive">{error}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            className="h-6 text-[11px]"
          >
            Retry
          </Button>
        </div>
      )}

      <RadioGroup value={preference} onValueChange={(v) => void handleChange(v)}>
        {options.map((option) => {
          const meta = PROVIDER_META[option.value];
          const disabled = option.state !== 'available';
          const isCliOnly = option.state === 'cli-only';

          return (
            <label
              key={option.value}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-4 py-3 transition-all duration-150',
                preference === option.value
                  ? 'bg-primary/[0.06] border-primary/20 cursor-pointer'
                  : option.state === 'available'
                    ? 'border-white/[0.06] hover:bg-white/[0.02] cursor-pointer'
                    : isCliOnly
                      ? 'border-white/[0.04] cursor-not-allowed'
                      : 'border-white/[0.03] cursor-not-allowed',
                disabled && !isCliOnly && 'opacity-30',
                isCliOnly && 'opacity-50',
              )}
            >
              <RadioGroupItem value={option.value} disabled={disabled} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground/80">{option.label}</span>
                  {meta.color && option.state === 'available' && (
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
                  )}
                  {option.value !== 'auto' && <StateIndicator state={option.state} />}
                </div>
                <p className="text-[11px] text-muted-foreground/40 mt-0.5">{option.description}</p>
              </div>
            </label>
          );
        })}
      </RadioGroup>

      {/* Explanatory note for CLI-only providers */}
      {hasCliOnly && (
        <p
          className="text-[11px] leading-relaxed px-1"
          style={{ color: 'oklch(0.75 0.15 70 / 0.5)' }}
        >
          <span className="font-medium" style={{ color: 'oklch(0.75 0.15 70 / 0.7)' }}>
            CLI only
          </span>{' '}
          — Agent sessions use this provider normally, but internal AI features require a direct API
          key. Set the API key in the provider&apos;s env var or config to enable it here.
        </p>
      )}
    </div>
  );
}

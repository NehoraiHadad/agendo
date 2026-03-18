'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Sparkles, Check } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type AiProviderPreference = 'auto' | 'anthropic' | 'openai' | 'gemini';

interface ProviderOption {
  value: AiProviderPreference;
  label: string;
  description: string;
  available: boolean;
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

export function AiProviderPreference() {
  const [preference, setPreference] = useState<AiProviderPreference>('auto');
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
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
        data: { preference: AiProviderPreference; availableProviders: string[] };
      };
      setPreference(body.data.preference);
      setAvailableProviders(body.data.availableProviders);
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

  const options: ProviderOption[] = (['auto', 'anthropic', 'openai', 'gemini'] as const).map(
    (value) => ({
      value,
      label: PROVIDER_META[value].label,
      description: PROVIDER_META[value].description,
      available: value === 'auto' || availableProviders.includes(value),
    }),
  );

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
          const disabled = !option.available;

          return (
            <label
              key={option.value}
              className={cn(
                'flex items-center gap-3 rounded-lg border border-white/[0.06] px-4 py-3 cursor-pointer transition-all duration-150',
                preference === option.value
                  ? 'bg-primary/[0.06] border-primary/20'
                  : 'hover:bg-white/[0.02]',
                disabled && 'opacity-40 cursor-not-allowed',
              )}
            >
              <RadioGroupItem value={option.value} disabled={disabled} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground/80">{option.label}</span>
                  {meta.color && option.available && (
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
                  )}
                  {disabled && (
                    <span className="text-[10px] text-muted-foreground/30 font-mono">
                      no credentials
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/40 mt-0.5">{option.description}</p>
              </div>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldX, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InteractiveTool } from '@/components/sessions/interactive-tools';

// Keep in sync with the TOOL_RENDERERS registry in interactive-tools.tsx.
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

// ---------------------------------------------------------------------------
// Danger level helpers
// ---------------------------------------------------------------------------

interface DangerMeta {
  label: string;
  icon: React.ReactNode;
  badgeVariant: 'secondary' | 'warning' | 'destructive';
  badgeClassName?: string;
}

function getDangerMeta(level: number): DangerMeta {
  switch (level) {
    case 0:
      return {
        label: 'Safe',
        icon: <ShieldCheck className="size-3.5 text-zinc-400" />,
        badgeVariant: 'secondary',
      };
    case 1:
      return {
        label: 'Caution',
        icon: <ShieldAlert className="size-3.5 text-amber-400" />,
        badgeVariant: 'warning',
      };
    case 2:
      return {
        label: 'Dangerous',
        icon: <Shield className="size-3.5 text-orange-400" />,
        badgeVariant: 'destructive',
        badgeClassName: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
      };
    case 3:
    default:
      return {
        label: 'Destructive',
        icon: <ShieldX className="size-3.5 text-red-400" />,
        badgeVariant: 'destructive',
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ToolApprovalCardProps {
  sessionId: string;
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  dangerLevel: number;
  onResolved: () => void;
}

type Decision = 'allow' | 'deny' | 'allow-session';

export function ToolApprovalCard({
  sessionId,
  approvalId,
  toolName,
  toolInput,
  dangerLevel,
  onResolved,
}: ToolApprovalCardProps) {
  const [pending, setPending] = useState<Decision | null>(null);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const danger = getDangerMeta(dangerLevel);
  const isDisabled = decided || pending !== null;

  const inputPreview = (() => {
    const full = JSON.stringify(toolInput, null, 2);
    return full.length > 300 ? full.slice(0, 300) + '\n…' : full;
  })();

  async function handleDecision(decision: Decision) {
    setError(null);
    setPending(decision);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'tool-approval',
          approvalId,
          toolName,
          decision,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      setDecided(true);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setPending(null);
    }
  }

  // Interactive tools (ExitPlanMode, …) delegate to the renderer registry.
  // The renderer calls respond({ kind:'approval', decision }) which we translate
  // into the same handleDecision() call used by the generic approval UI.
  if (INTERACTIVE_TOOL_NAMES.has(toolName)) {
    return (
      <InteractiveTool
        toolName={toolName}
        input={toolInput}
        isAnswered={decided}
        respond={async (payload) => {
          if (payload.kind !== 'approval') return;
          await handleDecision(payload.decision);
        }}
        onResolved={onResolved}
      />
    );
  }

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm">
      {/* Header row */}
      <div className="flex items-center gap-2">
        {danger.icon}
        <span className="font-mono font-medium text-foreground/90">{toolName}</span>
        <Badge variant={danger.badgeVariant} className={danger.badgeClassName}>
          {danger.label}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground/50">Tool approval required</span>
      </div>

      {/* Input preview */}
      <pre className="text-xs font-mono text-muted-foreground bg-black/40 rounded p-2 mt-2 overflow-auto max-h-24 whitespace-pre-wrap break-all">
        {inputPreview}
      </pre>

      {/* Error message */}
      {error && (
        <p className="mt-2 text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded px-2 py-1">
          {error}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 mt-3 flex-wrap">
        <Button
          size="sm"
          variant="default"
          disabled={isDisabled}
          onClick={() => handleDecision('allow')}
          className="bg-emerald-600/80 hover:bg-emerald-600 text-white border-0"
        >
          {pending === 'allow' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Allow
        </Button>

        <Button
          size="sm"
          variant="destructive"
          disabled={isDisabled}
          onClick={() => handleDecision('deny')}
        >
          {pending === 'deny' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <X className="size-3.5" />
          )}
          Deny
        </Button>

        <Button
          size="sm"
          variant="ghost"
          disabled={isDisabled}
          onClick={() => handleDecision('allow-session')}
          className="text-muted-foreground hover:text-foreground"
        >
          {pending === 'allow-session' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Always allow this session
        </Button>
      </div>
    </div>
  );
}

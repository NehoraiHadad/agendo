'use client';

import { useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldX, Check, X, Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InteractiveTool } from '@/components/sessions/interactive-tools';

// Keep in sync with the TOOL_RENDERERS registry in interactive-tools.tsx.
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

// ---------------------------------------------------------------------------
// Danger level config
// ---------------------------------------------------------------------------

interface DangerConfig {
  label: string;
  icon: React.ReactNode;
  /* Card border/bg */
  cardBorder: string;
  cardBg: string;
  /* Badge */
  badgeText: string;
  badgeBg: string;
  badgeBorder: string;
  /* Top accent bar color */
  accentBar: string;
}

function getDangerConfig(level: number): DangerConfig {
  switch (level) {
    case 0:
      return {
        label: 'Safe',
        icon: <ShieldCheck className="size-3.5 text-zinc-400" />,
        cardBorder: 'border-white/[0.08]',
        cardBg: 'bg-white/[0.02]',
        badgeText: 'text-zinc-400',
        badgeBg: 'bg-zinc-500/10',
        badgeBorder: 'border-zinc-500/20',
        accentBar: 'bg-zinc-500/40',
      };
    case 1:
      return {
        label: 'Caution',
        icon: <ShieldAlert className="size-3.5 text-amber-400" />,
        cardBorder: 'border-amber-500/25',
        cardBg: 'bg-amber-500/[0.04]',
        badgeText: 'text-amber-400',
        badgeBg: 'bg-amber-500/10',
        badgeBorder: 'border-amber-500/25',
        accentBar: 'bg-gradient-to-r from-amber-500/70 to-amber-500/20',
      };
    case 2:
      return {
        label: 'Dangerous',
        icon: <Shield className="size-3.5 text-orange-400" />,
        cardBorder: 'border-orange-500/30',
        cardBg: 'bg-orange-500/[0.05]',
        badgeText: 'text-orange-400',
        badgeBg: 'bg-orange-500/10',
        badgeBorder: 'border-orange-500/25',
        accentBar: 'bg-gradient-to-r from-orange-500/80 to-orange-500/20',
      };
    case 3:
    default:
      return {
        label: 'Destructive',
        icon: <ShieldX className="size-3.5 text-red-400" />,
        cardBorder: 'border-red-500/30',
        cardBg: 'bg-red-500/[0.05]',
        badgeText: 'text-red-400',
        badgeBg: 'bg-red-500/10',
        badgeBorder: 'border-red-500/25',
        accentBar: 'bg-gradient-to-r from-red-500/80 to-red-500/20',
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ToolApprovalCardProps {
  sessionId: string;
  sessionStatus?: string | null;
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  dangerLevel: number;
  onResolved: () => void;
}

type Decision = 'allow' | 'deny' | 'allow-session';

export function ToolApprovalCard({
  sessionId,
  sessionStatus: _sessionStatus,
  approvalId,
  toolName,
  toolInput,
  dangerLevel,
  onResolved,
}: ToolApprovalCardProps) {
  const [pending, setPending] = useState<Decision | null>(null);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // For Bash: edit the command string directly. For others: edit full JSON.
  const isBash = toolName === 'Bash';
  const initialEditValue = isBash
    ? String(toolInput.command ?? '')
    : JSON.stringify(toolInput, null, 2);
  const [editValue, setEditValue] = useState(initialEditValue);

  const cfg = getDangerConfig(dangerLevel);
  const isDisabled = decided || pending !== null;

  const inputPreview = (() => {
    const full = JSON.stringify(toolInput, null, 2);
    return full.length > 300 ? full.slice(0, 300) + '\n…' : full;
  })();

  async function handleDecision(
    decision: Decision,
    updatedInput?: Record<string, unknown>,
    extra?: {
      postApprovalMode?: string;
      postApprovalCompact?: boolean;
      clearContextRestart?: boolean;
    },
  ) {
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
          ...(updatedInput !== undefined ? { updatedInput } : {}),
          ...(extra?.postApprovalMode ? { postApprovalMode: extra.postApprovalMode } : {}),
          ...(extra?.postApprovalCompact ? { postApprovalCompact: true } : {}),
          ...(extra?.clearContextRestart ? { clearContextRestart: true } : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      setDecided(true);
      // Interactive tools (ExitPlanMode, AskUserQuestion) show their own
      // "resolved" compact view. Non-interactive tools are removed from the DOM.
      if (!INTERACTIVE_TOOL_NAMES.has(toolName)) {
        onResolved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setPending(null);
    }
  }

  function handleEditApprove() {
    setEditError(null);
    let updatedInput: Record<string, unknown>;
    if (isBash) {
      updatedInput = { ...toolInput, command: editValue };
    } else {
      try {
        updatedInput = JSON.parse(editValue) as Record<string, unknown>;
      } catch {
        setEditError('Invalid JSON — please fix before approving.');
        return;
      }
    }
    void handleDecision('allow', updatedInput);
  }

  if (INTERACTIVE_TOOL_NAMES.has(toolName)) {
    return (
      <InteractiveTool
        toolName={toolName}
        sessionId={sessionId}
        input={toolInput}
        isAnswered={decided}
        respond={async (payload) => {
          if (payload.kind !== 'approval') return;
          await handleDecision(payload.decision, payload.updatedInput, {
            postApprovalMode: payload.postApprovalMode,
            postApprovalCompact: payload.postApprovalCompact,
            clearContextRestart: payload.clearContextRestart,
          });
        }}
        onResolved={onResolved}
      />
    );
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${cfg.cardBorder} ${cfg.cardBg}`}>
      {/* Danger accent bar */}
      <div className={`h-[2px] w-full ${cfg.accentBar}`} />

      <div className="p-3 space-y-2.5">
        {/* Header row */}
        <div className="flex items-center gap-2 flex-wrap">
          {cfg.icon}
          <span className="font-mono text-sm font-semibold text-foreground/90">{toolName}</span>
          {/* Danger badge */}
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border ${cfg.badgeText} ${cfg.badgeBg} ${cfg.badgeBorder}`}
          >
            {cfg.label}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground/40 uppercase tracking-wide">
            Approval required
          </span>
        </div>

        {/* Input preview (hidden when edit mode is active) */}
        {!editMode && (
          <pre className="text-[11px] font-mono text-muted-foreground/60 bg-black/40 rounded-lg p-2.5 overflow-auto max-h-28 whitespace-pre-wrap break-all border border-white/[0.04]">
            {inputPreview}
          </pre>
        )}

        {/* Edit panel */}
        {editMode && (
          <div className="space-y-1.5">
            {isBash ? (
              <input
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                disabled={isDisabled}
                className="w-full text-[11px] font-mono bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-2 text-foreground/80 focus:outline-none focus:border-white/20"
                placeholder="Command"
              />
            ) : (
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                disabled={isDisabled}
                rows={6}
                className="w-full text-[11px] font-mono bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-2 text-foreground/80 focus:outline-none focus:border-white/20 resize-y"
              />
            )}
            {editError && <p className="text-xs text-red-400">{editError}</p>}
          </div>
        )}

        {/* Error message */}
        {error && (
          <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded-lg px-2.5 py-1.5">
            {error}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap">
          {!editMode ? (
            <>
              <Button
                size="sm"
                disabled={isDisabled}
                onClick={() => void handleDecision('allow')}
                className="h-8 gap-1.5 bg-emerald-600/80 hover:bg-emerald-600 text-white border-0 text-xs"
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
                onClick={() => void handleDecision('deny')}
                className="h-8 gap-1.5 text-xs"
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
                onClick={() => void handleDecision('allow-session')}
                className="h-8 gap-1.5 text-xs text-muted-foreground/60 hover:text-foreground border border-white/[0.06] hover:border-white/[0.12]"
              >
                {pending === 'allow-session' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Always allow
              </Button>

              <Button
                size="sm"
                variant="ghost"
                disabled={isDisabled}
                onClick={() => setEditMode(true)}
                className="h-8 gap-1.5 text-xs text-muted-foreground/60 hover:text-foreground border border-white/[0.06] hover:border-white/[0.12]"
              >
                <Pencil className="size-3.5" />
                Edit &amp; Approve
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={isDisabled}
                onClick={handleEditApprove}
                className="h-8 gap-1.5 bg-emerald-600/80 hover:bg-emerald-600 text-white border-0 text-xs"
              >
                {pending === 'allow' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Confirm Edit &amp; Approve
              </Button>

              <Button
                size="sm"
                variant="ghost"
                disabled={isDisabled}
                onClick={() => {
                  setEditMode(false);
                  setEditError(null);
                  setEditValue(initialEditValue);
                }}
                className="h-8 gap-1.5 text-xs text-muted-foreground/60 hover:text-foreground border border-white/[0.06] hover:border-white/[0.12]"
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

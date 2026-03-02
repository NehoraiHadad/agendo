'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  Loader2,
  PowerOff,
  Shield,
  ShieldCheck,
  ShieldOff,
  BookOpen,
  Pencil,
  Check,
  X,
  Cpu,
  Camera,
  MoreHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useSessionStream } from '@/hooks/use-session-stream';
import { useSessionLogStream } from '@/hooks/use-session-log-stream';
import { SessionChatView } from '@/components/sessions/session-chat-view';
import { SessionEventLog } from '@/components/sessions/session-event-log';
import { SessionInfoPanel } from '@/components/sessions/session-info-panel';
import { SessionLogViewer } from '@/components/sessions/session-log-viewer';
import { SaveSnapshotDialog } from '@/components/snapshots/save-snapshot-dialog';
import type { Session } from '@/lib/types';
import type { SessionStatus } from '@/lib/realtime/events';
import {
  getLatestContextStats,
  fmtTokens,
  fmtPct,
  ctxBarWidth,
  ctxBarColor,
  ctxTrackColor,
} from '@/lib/utils/context-stats';

const WebTerminal = dynamic(
  () => import('@/components/terminal/web-terminal').then((m) => m.WebTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[400px] items-center justify-center rounded-xl border border-white/[0.06] bg-[oklch(0.07_0_0)]">
        <span className="text-sm text-muted-foreground/60">Loading terminal…</span>
      </div>
    ),
  },
);

type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';

const MODE_CYCLE: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

/** Extract a short human-readable label from a model ID string.
 *  e.g. "claude-sonnet-4-5-20250514" → "Sonnet 4.5" */
function modelDisplayLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  // Match common Claude model families
  const families = ['opus', 'sonnet', 'haiku'];
  for (const fam of families) {
    const idx = lower.indexOf(fam);
    if (idx !== -1) {
      // Try to extract version numbers after the family name
      const rest = lower.slice(idx + fam.length).replace(/^-/, '');
      const versionMatch = rest.match(/^(\d+)[.-](\d+)/);
      const version = versionMatch ? ` ${versionMatch[1]}.${versionMatch[2]}` : '';
      return fam.charAt(0).toUpperCase() + fam.slice(1) + version;
    }
  }
  // Fallback: return the raw ID with claude- prefix stripped
  return modelId.replace(/^claude-/, '');
}

interface DynamicModelOption {
  id: string;
  label: string;
}

/** Derive provider name from binary path for model API queries. */
function deriveProvider(binaryPath: string): string {
  const base = binaryPath.split('/').pop()?.toLowerCase() ?? '';
  if (base.startsWith('claude')) return 'claude';
  if (base.startsWith('codex')) return 'codex';
  if (base.startsWith('gemini')) return 'gemini';
  return 'claude';
}

const MODE_CONFIG: Record<
  PermissionMode,
  { label: string; icon: React.ElementType; className: string; title: string }
> = {
  plan: {
    label: 'Plan',
    icon: BookOpen,
    className: 'text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 border-violet-500/20',
    title:
      'Plan mode: Claude presents a plan before executing changes. Click to switch to Approve mode.',
  },
  default: {
    label: 'Approve',
    icon: Shield,
    className: 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border-amber-500/20',
    title: 'Approve mode: each tool requires your approval. Click to switch to Edit-only mode.',
  },
  acceptEdits: {
    label: 'Edit Only',
    icon: ShieldCheck,
    className: 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 border-blue-500/20',
    title:
      'Edit-only mode: file edits are auto-approved, bash requires approval. Click to switch to Auto mode.',
  },
  bypassPermissions: {
    label: 'Auto',
    icon: ShieldOff,
    className:
      'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 border-emerald-500/20',
    title: 'Auto mode: all tools approved automatically. Click to switch to Plan mode.',
  },
  dontAsk: {
    label: 'Auto',
    icon: ShieldOff,
    className:
      'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 border-emerald-500/20',
    title: 'Auto mode: all tools approved automatically. Click to switch to Plan mode.',
  },
};

interface SessionDetailClientProps {
  session: Session;
  agentName: string;
  agentSlug: string;
  agentBinaryPath: string;
  capLabel: string;
  taskTitle: string;
  projectName: string;
}

interface StatusConfig {
  dotColor: string;
  pillBg: string;
  pillBorder: string;
  textColor: string;
  label: string;
  animate: boolean;
}

const STATUS_CONFIGS: Record<SessionStatus, StatusConfig> = {
  active: {
    dotColor: 'bg-blue-400',
    pillBg: 'bg-blue-500/10',
    pillBorder: 'border-blue-500/25',
    textColor: 'text-blue-400',
    label: 'Active',
    animate: true,
  },
  awaiting_input: {
    dotColor: 'bg-emerald-400',
    pillBg: 'bg-emerald-500/10',
    pillBorder: 'border-emerald-500/25',
    textColor: 'text-emerald-400',
    label: 'Your turn',
    animate: true,
  },
  idle: {
    dotColor: 'bg-zinc-500',
    pillBg: 'bg-zinc-500/10',
    pillBorder: 'border-zinc-600/20',
    textColor: 'text-zinc-400',
    label: 'Paused',
    animate: false,
  },
  ended: {
    dotColor: 'bg-zinc-600',
    pillBg: 'bg-zinc-700/10',
    pillBorder: 'border-zinc-700/20',
    textColor: 'text-zinc-500',
    label: 'Ended',
    animate: false,
  },
};

function SessionStatusIndicator({ status }: { status: SessionStatus | null }) {
  if (!status) return null;
  const cfg = STATUS_CONFIGS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-1 border ${cfg.pillBg} ${cfg.pillBorder} ${cfg.textColor}`}
    >
      <span
        className={`inline-block size-1.5 rounded-full ${cfg.dotColor} ${cfg.animate ? 'animate-pulse' : ''}`}
      />
      {cfg.label}
    </span>
  );
}

export function SessionDetailClient({
  session,
  agentName,
  agentSlug,
  agentBinaryPath,
  capLabel,
  taskTitle,
  projectName,
}: SessionDetailClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') ?? 'chat';
  const stream = useSessionStream(session.id);
  const currentStatus = stream.sessionStatus ?? session.status;
  const logStream = useSessionLogStream(session.id);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [showSaveSnapshot, setShowSaveSnapshot] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (session.permissionMode as PermissionMode) ?? 'bypassPermissions',
  );
  const [isModeChanging, setIsModeChanging] = useState(false);
  const [isModelChanging, setIsModelChanging] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const [dynamicModels, setDynamicModels] = useState<DynamicModelOption[]>([]);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelMenu]);

  // Close mobile ⋯ menu on outside click
  useEffect(() => {
    if (!showMobileMenu) return;
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMobileMenu]);

  // Fetch available models for this agent's provider
  useEffect(() => {
    const provider = deriveProvider(agentBinaryPath);
    const controller = new AbortController();
    fetch(`/api/models?provider=${encodeURIComponent(provider)}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ data: DynamicModelOption[] }>) : null))
      .then((body) => {
        if (!controller.signal.aborted && body?.data) {
          setDynamicModels(body.data.map((m) => ({ id: m.id, label: m.label })));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [agentBinaryPath]);

  const headerModels = dynamicModels;

  // Derive model from the latest system:info "Model switched" event, init event, or session DB.
  // system:info events from handleSetModel are the freshest source after a model switch.
  const lastModelInfoEvent = [...stream.events]
    .reverse()
    .find(
      (e) =>
        e.type === 'system:info' &&
        (e as Extract<typeof e, { type: 'system:info' }>).message.startsWith('Model switched to'),
    ) as Extract<(typeof stream.events)[number], { type: 'system:info' }> | undefined;
  const modelFromInfo = lastModelInfoEvent
    ? (lastModelInfoEvent.message.match(/Model switched to "(.+)"/)?.[1] ?? null)
    : null;
  const modelInitEvent = stream.events
    .filter((e): e is Extract<typeof e, { type: 'session:init' }> => e.type === 'session:init')
    .at(-1);
  const currentModel = modelFromInfo ?? modelInitEvent?.model ?? session.model ?? null;
  const modelLabel = currentModel ? modelDisplayLabel(currentModel) : null;

  const contextStats = useMemo(() => getLatestContextStats(stream.events), [stream.events]);

  async function handleModelChange(modelId: string) {
    if (isModelChanging || currentStatus === 'ended') return;
    setIsModelChanging(true);
    setShowModelMenu(false);
    try {
      const res = await fetch(`/api/sessions/${session.id}/model`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      if (!res.ok) {
        console.error('Model change failed:', res.status);
      }
    } finally {
      setIsModelChanging(false);
    }
  }

  // Session rename
  const [sessionTitle, setSessionTitle] = useState<string>(session.title ?? '');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editValue, setEditValue] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const startEditing = useCallback(() => {
    setEditValue(sessionTitle);
    setIsEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }, [sessionTitle]);

  const cancelEditing = useCallback(() => {
    setIsEditingTitle(false);
  }, []);

  const saveTitle = useCallback(async () => {
    const trimmed = editValue.trim();
    setIsEditingTitle(false);
    if (trimmed === sessionTitle) return;
    setSessionTitle(trimmed);
    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: trimmed || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Invalidate Next.js router cache so the title persists after navigation/refresh
      router.refresh();
    } catch {
      // Revert on error
      setSessionTitle(sessionTitle);
    }
  }, [editValue, session.id, sessionTitle, router]);

  async function handleEndSession() {
    if (isEnding) return;
    setIsEnding(true);
    setShowEndConfirm(false);
    try {
      await fetch(`/api/sessions/${session.id}/cancel`, { method: 'POST' });
    } finally {
      setIsEnding(false);
    }
  }

  async function handleModeChange() {
    if (isModeChanging || currentStatus === 'ended') return;
    const nextIndex = (MODE_CYCLE.indexOf(permissionMode) + 1) % MODE_CYCLE.length;
    const nextMode = MODE_CYCLE[nextIndex];
    setIsModeChanging(true);
    try {
      const res = await fetch(`/api/sessions/${session.id}/mode`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: nextMode }),
      });
      if (res.ok) {
        setPermissionMode(nextMode);
      }
    } finally {
      setIsModeChanging(false);
    }
  }

  const modeCfg = MODE_CONFIG[permissionMode];
  const ModeIcon = modeCfg.icon;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Header card */}
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] overflow-visible shrink-0 mb-4 sm:mb-5">
        {/* Status accent top bar */}
        <div
          className="h-[2px] w-full rounded-t-xl"
          style={{
            background:
              currentStatus === 'active'
                ? 'linear-gradient(90deg, oklch(0.6 0.2 250 / 0.8) 0%, oklch(0.6 0.2 250 / 0.1) 100%)'
                : currentStatus === 'awaiting_input'
                  ? 'linear-gradient(90deg, oklch(0.65 0.2 145 / 0.8) 0%, oklch(0.65 0.2 145 / 0.1) 100%)'
                  : 'linear-gradient(90deg, oklch(0.4 0 0 / 0.4) 0%, transparent 100%)',
          }}
        />

        {/*
         * Responsive layout strategy:
         * Mobile:  [back][title + status pill]   ← row 1 (order-1, order-2)
         *          [meta info · · ·]              ← row 2 (order-3, sm:hidden)
         *          [context bar]                  ← row 3 (order-4, sm:hidden)
         *          [Model][Snap][Mode][End]        ← row 4 (order-5 / sm:order-3)
         * Desktop: [back][title + meta]  [buttons] ← single row, no wrapping
         */}
        <div className="flex flex-wrap sm:flex-nowrap items-start sm:items-center gap-x-2 sm:gap-x-3 gap-y-0 px-3 sm:px-4 pt-3 pb-3">
          {/* Back button — order 1, vertically centred */}
          <Link href="/sessions" className="order-1 self-center shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.05] active:bg-white/[0.08] active:scale-95 transition-all"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          {/* Title + [desktop meta] — order 2, grows to fill remaining width */}
          <div className="order-2 flex-1 min-w-0">
            {/* Title row — title + status pill side by side */}
            <div className="flex items-center gap-2 flex-wrap">
              {isEditingTitle ? (
                <div className="flex items-center gap-1">
                  <input
                    ref={titleInputRef}
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveTitle();
                      if (e.key === 'Escape') cancelEditing();
                    }}
                    placeholder={`Session ${session.id.slice(0, 8)}`}
                    className="text-base font-semibold bg-white/[0.06] border border-white/[0.15] rounded-lg px-2.5 py-1 focus:outline-none focus:border-primary/50 min-w-0 w-44 sm:w-64"
                  />
                  <button
                    onClick={() => void saveTitle()}
                    className="p-1.5 text-emerald-400 hover:text-emerald-300 active:text-emerald-200 transition-colors rounded"
                    aria-label="Save"
                  >
                    <Check className="size-3.5" />
                  </button>
                  <button
                    onClick={cancelEditing}
                    className="p-1.5 text-muted-foreground/40 hover:text-muted-foreground active:text-foreground transition-colors rounded"
                    aria-label="Cancel"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={startEditing}
                  className="group flex items-center gap-1.5 text-base font-semibold hover:text-foreground/80 active:text-foreground/60 transition-colors text-left"
                  title="Click to rename session"
                >
                  <span className="font-mono text-foreground/90">
                    {sessionTitle || session.id.slice(0, 8)}
                  </span>
                  <Pencil className="size-3 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors shrink-0" />
                </button>
              )}

              <SessionStatusIndicator status={currentStatus} />
            </div>

            {/* Meta breadcrumb — desktop only (mobile gets its own row below) */}
            <div className="hidden sm:flex mt-1 items-center gap-1.5 text-xs text-muted-foreground/40 flex-wrap">
              <span className="text-muted-foreground/60">{agentName}</span>
              {session.kind !== 'conversation' && (
                <>
                  <span className="text-muted-foreground/20">·</span>
                  <span>{capLabel}</span>
                </>
              )}
              {projectName && (
                <>
                  <span className="text-muted-foreground/20">·</span>
                  <span>{projectName}</span>
                </>
              )}
              {taskTitle && (
                <>
                  <span className="text-muted-foreground/20">·</span>
                  <span className="truncate max-w-[200px]">{taskTitle}</span>
                </>
              )}
              {session.kind === 'conversation' && (
                <>
                  <span className="text-muted-foreground/20">·</span>
                  <span className="text-muted-foreground/50">Conversation</span>
                </>
              )}
              {contextStats && (
                <>
                  <span className="text-muted-foreground/20">·</span>
                  <span
                    className="inline-flex items-center gap-1.5"
                    title={
                      contextStats.contextWindow
                        ? `Context: ${contextStats.inputTokens.toLocaleString()} / ${contextStats.contextWindow.toLocaleString()} tokens (${fmtPct(contextStats.inputTokens / contextStats.contextWindow)} full)`
                        : `Context: ${contextStats.inputTokens.toLocaleString()} tokens used`
                    }
                  >
                    {contextStats.contextWindow && (
                      <span
                        className="relative inline-block h-[5px] w-12 rounded-full overflow-hidden shrink-0"
                        style={{
                          backgroundColor: ctxTrackColor(
                            contextStats.inputTokens / contextStats.contextWindow,
                          ),
                        }}
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full transition-[width]"
                          style={{
                            width: ctxBarWidth(
                              contextStats.inputTokens / contextStats.contextWindow,
                            ),
                            backgroundColor: ctxBarColor(
                              contextStats.inputTokens / contextStats.contextWindow,
                            ),
                          }}
                        />
                      </span>
                    )}
                    <span className="text-muted-foreground/60 font-mono text-[10px]">
                      {fmtTokens(contextStats.inputTokens)}
                      {contextStats.contextWindow
                        ? `/${fmtTokens(contextStats.contextWindow)}`
                        : ''}
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Mobile: meta info row — single truncated line */}
          <div className="sm:hidden order-4 w-full mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground/50 overflow-hidden min-w-0">
            <span className="text-muted-foreground/70 shrink-0">{agentName}</span>
            {session.kind !== 'conversation' && (
              <>
                <span className="text-muted-foreground/25 shrink-0">·</span>
                <span className="shrink-0">{capLabel}</span>
              </>
            )}
            {projectName && (
              <>
                <span className="text-muted-foreground/25 shrink-0">·</span>
                <span className="shrink-0">{projectName}</span>
              </>
            )}
            {taskTitle && (
              <>
                <span className="text-muted-foreground/25 shrink-0">·</span>
                <span className="truncate min-w-0">{taskTitle}</span>
              </>
            )}
            {session.kind === 'conversation' && (
              <>
                <span className="text-muted-foreground/25 shrink-0">·</span>
                <span className="shrink-0 text-muted-foreground/40">Conversation</span>
              </>
            )}
          </div>

          {/* Mobile: context bar row */}
          {contextStats?.contextWindow && (
            <div className="sm:hidden order-5 w-full mt-2 flex items-center gap-2.5">
              <div
                className="flex-1 relative h-[4px] rounded-full overflow-hidden"
                style={{
                  backgroundColor: ctxTrackColor(
                    contextStats.inputTokens / contextStats.contextWindow,
                  ),
                }}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-[width]"
                  style={{
                    width: ctxBarWidth(contextStats.inputTokens / contextStats.contextWindow),
                    backgroundColor: ctxBarColor(
                      contextStats.inputTokens / contextStats.contextWindow,
                    ),
                  }}
                />
              </div>
              <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0">
                {fmtTokens(contextStats.inputTokens)}/{fmtTokens(contextStats.contextWindow)}
              </span>
            </div>
          )}

          {/* Mobile: ⋯ menu button — sits inline in row 1 next to title */}
          {(currentStatus === 'active' ||
            currentStatus === 'awaiting_input' ||
            currentStatus === 'idle') && (
            <div className="sm:hidden order-3 self-center shrink-0 relative" ref={mobileMenuRef}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowMobileMenu((v) => !v)}
                className="h-8 w-8 text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.05] active:bg-white/[0.08] active:scale-95 transition-all border border-white/[0.06]"
                aria-label="Session actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>

              {showMobileMenu && (
                <div className="absolute right-0 top-full mt-1.5 z-50 w-60 rounded-xl border border-white/[0.08] bg-[oklch(0.11_0_0)] shadow-2xl overflow-hidden">
                  {/* Model section */}
                  {headerModels.length > 0 && (
                    <>
                      <div className="px-3 pt-3 pb-1.5">
                        <p className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider mb-1">
                          Model
                        </p>
                        {headerModels.map((m) => {
                          const isActiveModel =
                            currentModel?.toLowerCase() === m.id.toLowerCase() ||
                            currentModel?.toLowerCase().includes(m.id.toLowerCase());
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                void handleModelChange(m.id);
                                setShowMobileMenu(false);
                              }}
                              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm flex items-center justify-between transition-colors ${
                                isActiveModel
                                  ? 'text-cyan-400 bg-cyan-500/10'
                                  : 'text-foreground/70 hover:bg-white/[0.05]'
                              }`}
                            >
                              <span>{m.label}</span>
                              {isActiveModel && (
                                <span className="text-[10px] text-muted-foreground/40 font-mono">
                                  current
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div className="h-px bg-white/[0.06] mx-3" />
                    </>
                  )}

                  {/* Snapshot */}
                  {session.projectId && (
                    <button
                      onClick={() => {
                        setShowSaveSnapshot(true);
                        setShowMobileMenu(false);
                      }}
                      className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 text-teal-400 hover:bg-teal-500/[0.08] active:bg-teal-500/[0.12] transition-colors"
                    >
                      <Camera className="size-4 shrink-0" />
                      <span>Save snapshot</span>
                    </button>
                  )}

                  {/* Permission mode */}
                  <button
                    onClick={() => void handleModeChange()}
                    disabled={isModeChanging}
                    className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors hover:bg-white/[0.04] active:bg-white/[0.07] ${modeCfg.className.split(' ').find((c) => c.startsWith('text-')) ?? 'text-foreground/70'}`}
                  >
                    {isModeChanging ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <ModeIcon className="size-4 shrink-0" />
                    )}
                    <span className="flex-1">Permission</span>
                    <span className="text-xs font-medium opacity-70">{modeCfg.label}</span>
                  </button>

                  <div className="h-px bg-white/[0.06] mx-3" />

                  {/* End session */}
                  <button
                    onClick={() => {
                      setShowEndConfirm(true);
                      setShowMobileMenu(false);
                    }}
                    disabled={isEnding}
                    className="w-full text-left px-4 py-2.5 mb-1 text-sm flex items-center gap-3 text-red-400 hover:bg-red-500/[0.08] active:bg-red-500/[0.12] transition-colors"
                  >
                    {isEnding ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <PowerOff className="size-4 shrink-0" />
                    )}
                    <span>End session</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Desktop: individual labeled buttons — right column */}
          {(currentStatus === 'active' ||
            currentStatus === 'awaiting_input' ||
            currentStatus === 'idle') && (
            <div className="hidden sm:flex order-3 items-center gap-1.5 shrink-0">
              {/* Model selector */}
              <div className="relative" ref={modelMenuRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowModelMenu((v) => !v)}
                  disabled={isModelChanging}
                  title={currentModel ? `Model: ${currentModel}` : 'Select model'}
                  className="h-7 px-2.5 text-xs border gap-1.5 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 active:bg-cyan-500/15 active:scale-95 border-cyan-500/20 transition-all"
                >
                  {isModelChanging ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Cpu className="size-3" />
                  )}
                  <span>{modelLabel ?? 'Model'}</span>
                </Button>
                {showModelMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] max-w-[320px] max-h-72 overflow-y-auto rounded-md border border-white/[0.1] bg-[oklch(0.12_0_0)] shadow-lg py-1">
                    {headerModels.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground/50">
                        No models available
                      </div>
                    ) : (
                      headerModels.map((m) => {
                        const isActiveModel =
                          currentModel?.toLowerCase() === m.id.toLowerCase() ||
                          currentModel?.toLowerCase().includes(m.id.toLowerCase());
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => void handleModelChange(m.id)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/[0.06] transition-colors truncate ${
                              isActiveModel ? 'text-cyan-400 font-medium' : 'text-foreground/70'
                            }`}
                          >
                            {m.label}
                            {isActiveModel && (
                              <span className="ml-1.5 text-muted-foreground/40 font-mono text-[10px]">
                                current
                              </span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Save snapshot */}
              {session.projectId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSaveSnapshot(true)}
                  title="Save context snapshot"
                  className="h-7 px-2.5 text-xs border gap-1.5 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 active:bg-teal-500/15 active:scale-95 border-teal-500/20 transition-all"
                >
                  <Camera className="size-3" />
                  <span>Snapshot</span>
                </Button>
              )}

              {/* Permission mode */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleModeChange()}
                disabled={isModeChanging}
                title={modeCfg.title}
                className={`h-7 px-2.5 text-xs border gap-1.5 active:scale-95 transition-all ${modeCfg.className}`}
              >
                {isModeChanging ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ModeIcon className="size-3" />
                )}
                <span>{modeCfg.label}</span>
              </Button>

              {/* End session */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowEndConfirm(true)}
                disabled={isEnding}
                className="h-7 px-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 active:bg-red-500/15 active:scale-95 border border-red-500/20 gap-1.5 transition-all"
              >
                {isEnding ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <PowerOff className="size-3" />
                )}
                <span>End</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab} className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <TabsList className="flex w-full overflow-x-auto shrink-0">
          <TabsTrigger value="chat" className="shrink-0">
            Chat
          </TabsTrigger>
          <TabsTrigger value="terminal" className="shrink-0">
            Terminal
          </TabsTrigger>
          <TabsTrigger value="logs" className="shrink-0">
            Logs
          </TabsTrigger>
          <TabsTrigger value="events" className="shrink-0">
            Events
          </TabsTrigger>
          <TabsTrigger value="info" className="shrink-0">
            Info
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="chat"
          forceMount
          className="mt-3 data-[state=inactive]:hidden flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <SessionChatView
            sessionId={session.id}
            stream={stream}
            currentStatus={currentStatus}
            initialPrompt={session.initialPrompt}
            agentBinaryPath={agentBinaryPath}
          />
        </TabsContent>

        <TabsContent value="terminal" className="mt-4">
          <WebTerminal sessionId={session.id} className="h-[300px] sm:h-[500px]" />
        </TabsContent>

        <TabsContent value="logs" className="mt-4 flex-1 min-h-0 overflow-y-auto">
          <SessionLogViewer stream={logStream} />
        </TabsContent>

        <TabsContent value="events" className="mt-4 flex-1 min-h-0 overflow-y-auto">
          <SessionEventLog events={stream.events} />
        </TabsContent>

        <TabsContent value="info" className="mt-4 flex-1 min-h-0 overflow-y-auto">
          <SessionInfoPanel
            session={session}
            stream={stream}
            agentName={agentName}
            agentSlug={agentSlug}
            projectName={projectName}
          />
        </TabsContent>
      </Tabs>

      {/* Save snapshot dialog */}
      <SaveSnapshotDialog
        open={showSaveSnapshot}
        onOpenChange={setShowSaveSnapshot}
        sessionId={session.id}
        projectId={session.projectId ?? null}
      />

      {/* End session confirmation */}
      <Dialog open={showEndConfirm} onOpenChange={(v) => !v && setShowEndConfirm(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End session?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The agent process will be killed and the session will be marked as ended. This cannot be
            undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEndConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleEndSession()}>
              End Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

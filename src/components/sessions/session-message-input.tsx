'use client';

import { useState, useRef, useEffect } from 'react';
import { useDraft } from '@/hooks/use-draft';
import { Loader2, Send, Paperclip, X, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api-types';
import { ModelPickerPopover } from '@/components/sessions/model-picker-popover';
import { MemoryEditorModal } from '@/components/sessions/memory-editor-modal';
import type { SessionStatus } from '@/lib/realtime/events';
import { deriveProvider } from '@/lib/utils/session-controls';

// ---------------------------------------------------------------------------
// Slash commands — populated live from the agent's system:init event
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
  hasArgs?: boolean;
  /** Actual argument hint from the SDK, e.g. "<instructions>" or "<file>" */
  argumentHint?: string;
  /** Needs a native UI interaction; cannot be sent as raw text */
  interactive?: boolean;
  /** Requires interactive TUI; cannot be used in headless mode */
  blocked?: boolean;
}

// UI behaviour flags for known commands — applied on top of SDK-provided data.
// The SDK gives us name/description/argumentHint but not which commands open native
// UI dialogs (interactive) or produce unreadable TUI output (blocked).
// These are Agendo-UI concerns, not agent-protocol concerns.
const COMMAND_FLAGS: Record<string, Pick<SlashCommand, 'interactive' | 'blocked'>> = {
  '/model': { interactive: true },
  '/memory': { interactive: true },
  '/exit': { interactive: true },
  '/terminal': { interactive: true },
  '/login': { interactive: true },
  '/logout': { interactive: true },
  '/mcp': { blocked: true },
  '/permissions': { blocked: true },
};

// ---------------------------------------------------------------------------
// SlashCommandPicker
// ---------------------------------------------------------------------------

interface SlashCommandPickerProps {
  commands: SlashCommand[];
  activeIdx: number;
  onSelect: (cmd: SlashCommand) => void;
  onChangeActive: (idx: number) => void;
}

function SlashCommandPicker({
  commands,
  activeIdx,
  onSelect,
  onChangeActive,
}: SlashCommandPickerProps) {
  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1.5 z-50 rounded-xl border border-white/[0.10] bg-[oklch(0.085_0_0)] shadow-[0_-8px_32px_oklch(0_0_0/0.5),0_0_0_1px_oklch(1_0_0/0.04)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider font-medium">
          Slash commands
        </span>
        <span className="text-[9px] text-muted-foreground/25 hidden sm:inline">
          ↑↓ navigate · ↵ select · Esc dismiss
        </span>
      </div>
      <ul className="max-h-48 overflow-auto" role="listbox">
        {commands.map((cmd, i) => {
          return (
            <li key={`${i}-${cmd.name}`}>
              <div
                role="option"
                aria-selected={i === activeIdx}
                className={`flex items-baseline gap-3 px-3 py-2 cursor-pointer text-xs transition-all duration-100 ${
                  i === activeIdx
                    ? 'bg-primary/[0.09] border-l-2 border-primary/50 pl-[10px]'
                    : 'border-l-2 border-transparent hover:bg-white/[0.03] hover:border-white/[0.06]'
                }`}
                onMouseEnter={() => onChangeActive(i)}
                onClick={() => onSelect(cmd)}
              >
                <span
                  className={`font-mono shrink-0 transition-colors ${i === activeIdx ? 'text-primary' : 'text-primary/70'}`}
                >
                  {cmd.name}
                </span>
                <span className="text-muted-foreground/55 truncate">{cmd.description}</span>
                <span className="ml-auto shrink-0 flex items-center gap-1">
                  {cmd.blocked && (
                    <span
                      className="text-amber-500/50 text-[10px] font-mono"
                      title="Opens interactive TUI — not available in this view"
                    >
                      ⊘
                    </span>
                  )}
                  {cmd.interactive && !cmd.blocked && (
                    <ExternalLink className="size-2.5 text-muted-foreground/30" />
                  )}
                  {cmd.hasArgs && !cmd.interactive && !cmd.blocked && (
                    <span className="text-muted-foreground/40 italic text-[10px]">
                      {cmd.argumentHint ?? '+ args'}
                    </span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingImage {
  dataUrl: string;
  mimeType: string;
  data: string;
}

/** Image payload shape for queued messages (base64 data for POST body). */
export interface QueuedImagePayload {
  mimeType: string;
  data: string;
}

interface SessionMessageInputProps {
  sessionId: string;
  status?: SessionStatus | null;
  onSent?: (text: string, imageDataUrl?: string) => void;
  /** Called when a message is queued while agent is active — shows pill + POSTs with priority. */
  onQueue?: (
    text: string,
    imageDataUrl?: string,
    imagePayload?: QueuedImagePayload,
  ) => Promise<void>;
  /** Text to restore into the textarea when the user edits a queued message.
   *  Wrapped in an object with a monotonic key so the effect re-fires even if the text is identical. */
  restoredDraft?: { text: string; key: number } | null;
  /** Image to restore when the user edits a queued message. */
  restoredImage?: PendingImage | null;
  /** Live slash commands received from the agent's system:init event (bare names, fallback) */
  slashCommands?: string[];
  /** Rich slash commands from the agent's session:commands event (name + description + argumentHint) */
  richSlashCommands?: Array<{ name: string; description: string; argumentHint: string }>;
  /** MCP servers received from the agent's system:init event */
  mcpServers?: Array<{ name: string; status?: string; tools?: string[] }>;
  /** Agent binary path — used to derive provider for model picker */
  agentBinaryPath?: string;
  /** True when the session has never been started (lazy-start mode) */
  neverStarted?: boolean;
  /** Predicted next prompt from the Claude SDK promptSuggestions feature (Claude only) */
  promptSuggestion?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 128) + 'px';
}

function getBlockedMessage(
  name: string,
  mcpServers?: Array<{ name: string; status?: string; tools?: string[] }>,
): string {
  if (name === '/mcp') {
    const names = mcpServers?.map((s) => s.name).join(', ');
    return names
      ? `MCP servers for this session: ${names}`
      : 'No MCP servers configured for this session.';
  }
  if (name === '/permissions') {
    return 'Session permission mode is set at launch time and cannot be changed mid-session.';
  }
  return `"${name}" opens an interactive TUI that cannot be used in this session view.`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SessionMessageInput({
  sessionId,
  status,
  onSent,
  onQueue,
  restoredDraft,
  restoredImage,
  slashCommands,
  richSlashCommands,
  mcpServers,
  agentBinaryPath,
  neverStarted,
  promptSuggestion,
}: SessionMessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Track the last suggestion text that was dismissed or used, to avoid re-showing the same one.
  const [suppressedSuggestion, setSuppressedSuggestion] = useState<string | null>(null);

  // Active suggestion = the prop suggestion unless it was suppressed by the user
  const activeSuggestion =
    promptSuggestion && promptSuggestion !== suppressedSuggestion ? promptSuggestion : undefined;

  // Interactive command UI states
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showMemoryEditor, setShowMemoryEditor] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { saveDraft, getDraft, clearDraft } = useDraft(`draft:session:${sessionId}`);

  // Restore draft on mount (once per sessionId)
  useEffect(() => {
    const saved = getDraft();
    if (saved) {
      setMessage(saved);
      requestAnimationFrame(() => {
        if (textareaRef.current) autoGrow(textareaRef.current);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Restore textarea content when user edits a queued message (pill → back to input).
  // The object wrapper with a monotonic `key` ensures the effect fires even when
  // the text hasn't changed (e.g. edit → cancel → re-type same text → edit again).
  useEffect(() => {
    if (restoredDraft == null) return;
    setMessage(restoredDraft.text);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        autoGrow(textareaRef.current);
        textareaRef.current.focus();
        const len = restoredDraft.text.length;
        textareaRef.current.setSelectionRange(len, len);
      }
    });
  }, [restoredDraft]);

  // Restore image attachment when user edits a queued message
  useEffect(() => {
    if (restoredImage) setPendingImage(restoredImage);
  }, [restoredImage]);

  const isAccepting =
    status === 'active' || status === 'awaiting_input' || status === 'idle' || status === 'ended';

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Build the command list for the picker.
  // Rich path (session:commands event): full SDK list with UI-behaviour flags applied.
  // Bare fallback (system:init only): skill names only — no guessing at builtins.
  const allCommands: SlashCommand[] = (() => {
    if (richSlashCommands && richSlashCommands.length > 0) {
      const seen = new Set<string>();
      return richSlashCommands.flatMap((rc) => {
        const key = `/${rc.name}`;
        if (seen.has(key)) return [];
        seen.add(key);
        const hint = rc.argumentHint || undefined;
        return [
          {
            name: key,
            description: rc.description,
            hasArgs: !!hint,
            argumentHint: hint,
            ...COMMAND_FLAGS[key],
          },
        ];
      });
    }
    // Bare names only — wait for the SDK to return rich data before showing builtins
    const seen = new Set<string>();
    return (slashCommands ?? []).flatMap((name) => {
      const key = `/${name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ name: key, description: name.replace(/-/g, ' ') }];
    });
  })();

  const slashQuery = showPicker ? message.slice(1) : '';
  const filteredCommands = allCommands.filter((c) =>
    c.name.toLowerCase().includes(slashQuery.toLowerCase()),
  );

  function handleInteractiveCommand(name: string) {
    switch (name) {
      case '/model':
        setShowModelPicker(true);
        break;
      case '/memory':
        setShowMemoryEditor(true);
        break;
      case '/exit':
        setShowExitConfirm(true);
        break;
      case '/terminal':
        setToast(
          'Terminal is available in the execution view. Open an execution and use the Terminal tab.',
        );
        break;
      default:
        setToast(
          `"${name}" requires terminal interaction. Use the Terminal tab in an execution view.`,
        );
    }
  }

  function selectCommand(cmd: SlashCommand) {
    setShowPicker(false);
    setMessage('');

    if (cmd.blocked) {
      setToast(getBlockedMessage(cmd.name, mcpServers));
      return;
    }

    if (cmd.interactive) {
      handleInteractiveCommand(cmd.name);
      return;
    }

    if (!cmd.hasArgs) {
      void submitText(cmd.name);
      return;
    }
    const insert = `${cmd.name} `;
    setMessage(insert);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const len = insert.length;
        textareaRef.current.setSelectionRange(len, len);
        autoGrow(textareaRef.current);
      }
    });
  }

  async function submitText(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && !pendingImage) || isSending) return;

    // Guard blocked commands — they crash Claude in stream-json mode
    const blockedCmd = allCommands.find((c) => c.blocked && trimmed.split(/\s/)[0] === c.name);
    if (blockedCmd) {
      setToast(getBlockedMessage(blockedCmd.name, mcpServers));
      return;
    }

    // Queue path: when the agent is mid-turn, show the pill and POST immediately
    // with priority: 'next'. The backend queues it for delivery after the current turn.
    if (status === 'active' && onQueue) {
      const imgPayload = pendingImage
        ? { mimeType: pendingImage.mimeType, data: pendingImage.data }
        : undefined;
      setMessage('');
      clearDraft();
      setPendingImage(null);
      setSuppressedSuggestion(promptSuggestion ?? null);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      // onQueue handles pill display, POST with priority, and abort on edit/cancel
      void onQueue(trimmed, pendingImage?.dataUrl, imgPayload);
      return;
    }

    setIsSending(true);
    // Clear any active suggestion when the user sends — it's stale after this turn.
    setSuppressedSuggestion(promptSuggestion ?? null);
    // Capture image URL before clearing pendingImage state
    const sentImageDataUrl = pendingImage?.dataUrl;
    // Notify parent BEFORE the HTTP request so the optimistic-message baseline is
    // captured before the SSE `user:message` event can arrive and update the count.
    // If we called onSent after await, a fast SSE delivery would set baseUserMsgCount
    // equal to the new count, making the clearing condition (newCount > base) never fire.
    onSent?.(trimmed, sentImageDataUrl);
    try {
      const body: Record<string, unknown> = { message: trimmed };
      if (pendingImage) {
        body.image = { mimeType: pendingImage.mimeType, data: pendingImage.data };
      }
      await apiFetch(`/api/sessions/${sessionId}/message`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessage('');
      clearDraft();
      setPendingImage(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch {
      // transient error — user can retry
    } finally {
      setIsSending(false);
    }
  }

  async function submitMessage() {
    setShowPicker(false);
    await submitText(message);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setMessage(val);
    autoGrow(e.target);
    saveDraft(val);
    if (val.startsWith('/')) {
      setShowPicker(true);
      setShowModelPicker(false);
      setActiveIdx(0);
    } else {
      setShowPicker(false);
    }
  }

  // Shared image-processing logic used by both the file picker and the paste handler.
  function processImageFile(file: File | Blob) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, commaIdx);
      const rawData = dataUrl.slice(commaIdx + 1);
      let mimeType = (meta.match(/:(.*?);/)?.[1] ?? 'image/png').toLowerCase();
      if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
      if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
        setPendingImage({ dataUrl, mimeType, data: rawData });
        return;
      }
      // Convert unsupported format → JPEG via canvas
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const jpegData = jpegDataUrl.slice(jpegDataUrl.indexOf(',') + 1);
        setPendingImage({ dataUrl: jpegDataUrl, mimeType: 'image/jpeg', data: jpegData });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  // Document-level paste listener: Chrome filters image items from clipboardData when the
  // target is a <textarea>, so the React onPaste never sees the image and doesn't call
  // preventDefault — causing Chrome to show "doesn't support pasting images here".
  // Listening at document level intercepts the event before Chrome's fallback kicks in.
  useEffect(() => {
    function onDocPaste(e: ClipboardEvent) {
      // Only intercept when this input form is focused
      const form = textareaRef.current?.closest('form');
      if (!form?.contains(document.activeElement)) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) processImageFile(file);
    }
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showPicker && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && filteredCommands[activeIdx]) {
        e.preventDefault();
        selectCommand(filteredCommands[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        setShowPicker(false);
        return;
      }
    }
    if (e.key === 'Escape' && showModelPicker) {
      setShowModelPicker(false);
      return;
    }
    // Accept inline ghost suggestion with Tab (when input is empty and no picker is open)
    if (e.key === 'Tab' && activeSuggestion && !message && !showPicker && !showModelPicker) {
      e.preventDefault();
      setMessage(activeSuggestion);
      setSuppressedSuggestion(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          autoGrow(textareaRef.current);
          const len = activeSuggestion.length;
          textareaRef.current.setSelectionRange(len, len);
        }
      });
      return;
    }
    // Dismiss ghost suggestion with Escape (when no other picker is open)
    if (e.key === 'Escape' && activeSuggestion && !showPicker && !showModelPicker) {
      setSuppressedSuggestion(activeSuggestion);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  }

  useEffect(() => {
    if (!showPicker && !showModelPicker) return;
    function handleClick(e: MouseEvent) {
      if (textareaRef.current && !textareaRef.current.closest('form')?.contains(e.target as Node)) {
        setShowPicker(false);
        setShowModelPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPicker, showModelPicker]);

  const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, commaIdx);
      const rawData = dataUrl.slice(commaIdx + 1);
      // Normalize: image/jpg → image/jpeg
      let mimeType = (meta.match(/:(.*?);/)?.[1] ?? 'image/png').toLowerCase();
      if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

      if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
        setPendingImage({ dataUrl, mimeType, data: rawData });
        return;
      }

      // Unsupported format — convert to JPEG via canvas
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const jpegData = jpegDataUrl.slice(jpegDataUrl.indexOf(',') + 1);
        setPendingImage({ dataUrl: jpegDataUrl, mimeType: 'image/jpeg', data: jpegData });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitMessage();
  }

  if (!isAccepting) return null;

  const isIdle = status === 'idle' || status === 'ended';
  const placeholder = neverStarted
    ? 'Start a conversation…'
    : isIdle
      ? 'Resume session…'
      : 'Message agent… or / for commands';

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="relative shrink-0 flex flex-col gap-0 border-t border-white/[0.06] bg-[oklch(0.075_0.002_280)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[inset_0_1px_0_oklch(1_0_0/0.04)]"
      >
        {/* Slash command picker */}
        {showPicker && filteredCommands.length > 0 && !showModelPicker && (
          <SlashCommandPicker
            commands={filteredCommands}
            activeIdx={activeIdx}
            onSelect={selectCommand}
            onChangeActive={setActiveIdx}
          />
        )}

        {/* Model picker */}
        {showModelPicker && (
          <ModelPickerPopover
            provider={deriveProvider(agentBinaryPath ?? '')}
            onSelect={(modelId) => {
              setShowModelPicker(false);
              void apiFetch(`/api/sessions/${sessionId}/model`, {
                method: 'PATCH',
                body: JSON.stringify({ model: modelId }),
              });
            }}
            onClose={() => setShowModelPicker(false)}
          />
        )}

        {/* Toast banner */}
        {toast && (
          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 mx-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-950/60 px-3 py-2 text-xs text-amber-200/80 shadow-lg">
              <ExternalLink className="size-3.5 mt-0.5 shrink-0 text-amber-400/70" />
              <span className="flex-1">{toast}</span>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="shrink-0 text-amber-400/50 hover:text-amber-400/90"
              >
                <X className="size-3" />
              </button>
            </div>
          </div>
        )}

        {/* Image preview */}
        {pendingImage && (
          <div className="mb-2.5 flex items-start">
            <div className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pendingImage.dataUrl}
                alt="attachment"
                className="h-16 w-16 object-cover rounded-xl border border-white/[0.12] shadow-[0_4px_12px_oklch(0_0_0/0.4)]"
              />
              <button
                type="button"
                onClick={() => setPendingImage(null)}
                className="absolute -top-1.5 -right-1.5 rounded-full bg-zinc-900 border border-white/[0.15] p-0.5 text-muted-foreground/70 hover:text-foreground hover:bg-zinc-800 transition-all shadow-sm"
                aria-label="Remove image"
              >
                <X className="size-2.5" />
              </button>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Image attach button */}
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 flex items-center justify-center h-[44px] w-9 rounded-xl border border-white/[0.09] bg-white/[0.03] text-muted-foreground/40 hover:text-muted-foreground/80 hover:bg-white/[0.07] hover:border-white/[0.14] active:scale-95 transition-all duration-150 disabled:opacity-25"
              disabled={isSending}
              aria-label="Attach image"
            >
              <Paperclip className="size-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />
          </>

          {/* Textarea with inline ghost suggestion (Copilot-style). Ghost text appears
              when the input is empty and Claude has predicted a follow-up. Tab accepts,
              Escape dismisses. Only shown for Claude sessions (prop gated upstream). */}
          <div className="relative flex-1">
            {activeSuggestion && !message && (
              <>
                <div
                  aria-hidden="true"
                  dir="auto"
                  className="pointer-events-none absolute inset-0 rounded-xl px-3 py-[11px] text-sm leading-tight text-primary/45 overflow-hidden whitespace-pre-wrap break-words select-none animate-in fade-in duration-300"
                >
                  {activeSuggestion}
                </div>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-1.5 right-2 text-[10px] font-medium text-primary/40 bg-primary/8 border border-primary/20 rounded px-1 py-0.5 leading-none select-none animate-in fade-in duration-300"
                >
                  Tab ↵
                </span>
              </>
            )}
            <textarea
              ref={textareaRef}
              value={message}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={activeSuggestion ? '' : placeholder}
              rows={1}
              dir="auto"
              className="w-full min-h-[44px] max-h-32 rounded-xl border border-white/[0.09] bg-[oklch(0.08_0_0)] px-3 py-[11px] text-sm text-foreground placeholder:text-muted-foreground/35 focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 focus:bg-[oklch(0.085_0.003_280)] disabled:opacity-40 transition-[border-color,box-shadow,background-color] resize-none leading-tight overflow-y-auto"
              disabled={isSending}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <Button
            type="submit"
            size="icon"
            className="shrink-0 h-[44px] w-[44px] rounded-xl shadow-[0_2px_8px_oklch(0.7_0.18_280/0.2)] hover:shadow-[0_4px_16px_oklch(0.7_0.18_280/0.35)] active:scale-95 transition-all duration-150 disabled:shadow-none"
            disabled={(!message.trim() && !pendingImage) || isSending}
            aria-label="Send message"
          >
            {isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </form>

      {/* Memory editor — rendered outside the form so the dialog portal works */}
      <MemoryEditorModal
        apiPath={`/api/sessions/${sessionId}/memory`}
        open={showMemoryEditor}
        onClose={() => setShowMemoryEditor(false)}
      />

      {/* Exit confirmation dialog */}
      <Dialog open={showExitConfirm} onOpenChange={(v) => !v && setShowExitConfirm(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End session?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The session will be closed. You can resume it later by sending a new message.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExitConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowExitConfirm(false);
                void submitText('/exit');
              }}
            >
              End session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

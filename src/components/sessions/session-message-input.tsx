'use client';

import { useState, useRef, useEffect } from 'react';
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

// ---------------------------------------------------------------------------
// Slash commands — populated live from the agent's system:init event
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
  hasArgs?: boolean;
  /** Needs a native UI interaction; cannot be sent as raw text */
  interactive?: boolean;
  /** Crashes Claude in stream-json mode — must be blocked at the UI layer */
  blocked?: boolean;
  category?: 'skill' | 'builtin';
}

// Commands that accept arguments (agent doesn't tell us this, so we maintain
// a small set here just for the "+ args" label and to keep cursor after name).
const COMMANDS_WITH_ARGS = new Set(['compact', 'model', 'pr_comments', 'review']);

// Built-in Claude Code commands that are always available but NOT included in
// the slash_commands field of the system:init event (Claude only advertises
// skills + a subset of builtins there).
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: '/clear', description: 'Clear conversation history', category: 'builtin' },
  {
    name: '/compact',
    description: 'Compact context with summary',
    category: 'builtin',
    hasArgs: true,
  },
  { name: '/cost', description: 'Show token usage and cost', category: 'builtin' },
  { name: '/status', description: 'Show account and system status', category: 'builtin' },
  { name: '/doctor', description: 'Check system health', category: 'builtin' },
  { name: '/bug', description: 'Submit a bug report', category: 'builtin' },
  { name: '/help', description: 'Show help and all commands', category: 'builtin' },
  { name: '/vim', description: 'Toggle vim keybindings', category: 'builtin' },
  { name: '/model', description: 'Switch the AI model', category: 'builtin', interactive: true },
  {
    name: '/memory',
    description: 'Edit Claude memory files',
    category: 'builtin',
    interactive: true,
  },
  { name: '/exit', description: 'End the current session', category: 'builtin', interactive: true },
  {
    name: '/terminal',
    description: 'Open a terminal session',
    category: 'builtin',
    interactive: true,
  },
  { name: '/mcp', description: 'List MCP server connections', category: 'builtin', blocked: true },
  {
    name: '/permissions',
    description: 'List tool permissions',
    category: 'builtin',
    blocked: true,
  },
  {
    name: '/login',
    description: 'Switch Anthropic account',
    category: 'builtin',
    interactive: true,
  },
  {
    name: '/logout',
    description: 'Log out of current account',
    category: 'builtin',
    interactive: true,
  },
];

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

  const hasSkills = commands.some((c) => c.category === 'skill' || !c.category);
  const hasBuiltins = commands.some((c) => c.category === 'builtin');
  const showCategories = hasSkills && hasBuiltins;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border border-white/[0.10] bg-[oklch(0.10_0_0)] shadow-2xl overflow-hidden">
      <div className="px-3 py-1.5 border-b border-white/[0.06]">
        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">
          Slash commands · ↑↓ navigate · ↵ select · Esc dismiss
        </span>
      </div>
      <ul className="max-h-48 overflow-auto" role="listbox">
        {showCategories && hasSkills && (
          <li className="px-3 pt-1.5 pb-0.5" aria-hidden>
            <span className="text-[9px] text-muted-foreground/35 uppercase tracking-widest">
              Skills
            </span>
          </li>
        )}
        {commands.map((cmd, i) => {
          const isFirstBuiltin =
            showCategories &&
            cmd.category === 'builtin' &&
            (i === 0 || commands[i - 1]?.category !== 'builtin');

          return (
            <li key={`${i}-${cmd.name}`}>
              {isFirstBuiltin && (
                <div className="px-3 py-1 border-t border-white/[0.06] mt-0.5">
                  <span className="text-[9px] text-muted-foreground/35 uppercase tracking-widest">
                    Commands
                  </span>
                </div>
              )}
              <div
                role="option"
                aria-selected={i === activeIdx}
                className={`flex items-baseline gap-3 px-3 py-2 cursor-pointer text-xs transition-colors ${
                  i === activeIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                }`}
                onMouseEnter={() => onChangeActive(i)}
                onClick={() => onSelect(cmd)}
              >
                <span className="font-mono text-primary shrink-0">{cmd.name}</span>
                <span className="text-muted-foreground/60 truncate">{cmd.description}</span>
                <span className="ml-auto shrink-0 flex items-center gap-1">
                  {cmd.blocked && (
                    <span
                      className="text-amber-500/50 text-[10px] font-mono"
                      title="Not available in stream mode"
                    >
                      ⊘
                    </span>
                  )}
                  {cmd.interactive && !cmd.blocked && (
                    <ExternalLink className="size-2.5 text-muted-foreground/30" />
                  )}
                  {cmd.hasArgs && !cmd.interactive && !cmd.blocked && (
                    <span className="text-muted-foreground/40 italic text-[10px]">+ args</span>
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

interface SessionMessageInputProps {
  sessionId: string;
  status?: SessionStatus | null;
  onSent?: (text: string, imageDataUrl?: string) => void;
  /** Live slash commands received from the agent's system:init event */
  slashCommands?: string[];
  /** MCP servers received from the agent's system:init event */
  mcpServers?: Array<{ name: string; status?: string; tools?: string[] }>;
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
  return `"${name}" cannot be sent in stream-json mode.`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SessionMessageInput({
  sessionId,
  status,
  onSent,
  slashCommands,
  mcpServers,
}: SessionMessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Interactive command UI states
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showMemoryEditor, setShowMemoryEditor] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAccepting =
    status === 'active' || status === 'awaiting_input' || status === 'idle' || status === 'ended';

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Live commands from the agent + always-on builtins Claude doesn't advertise.
  // Live list takes priority; builtins fill in whatever is missing.
  // Deduplicate live commands (Claude can report the same skill multiple times).
  const seenLive = new Set<string>();
  const liveCommands: SlashCommand[] = (slashCommands ?? []).flatMap((name) => {
    const key = `/${name}`;
    if (seenLive.has(key)) return [];
    seenLive.add(key);
    return [
      {
        name: key,
        description: name.replace(/-/g, ' '),
        hasArgs: COMMANDS_WITH_ARGS.has(name),
        category: 'skill' as const,
      },
    ];
  });
  const liveNames = new Set(liveCommands.map((c) => c.name));
  const allCommands: SlashCommand[] = [
    ...liveCommands,
    ...BUILTIN_COMMANDS.filter((c) => !liveNames.has(c.name)),
  ];

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

    setIsSending(true);
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
      setPendingImage(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      onSent?.(trimmed, pendingImage?.dataUrl);
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
  const placeholder = isIdle ? 'Resume session…' : 'Message agent… or / for commands';

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="relative flex flex-col gap-0 border-t border-white/[0.07] bg-[oklch(0.09_0_0)] px-3 py-2.5"
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
            onSelect={(modelId) => {
              void submitText(`/model ${modelId}`);
              setShowModelPicker(false);
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
          <div className="mb-2 flex items-start">
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pendingImage.dataUrl}
                alt="attachment"
                className="h-16 w-16 object-cover rounded-lg border border-white/[0.10]"
              />
              <button
                type="button"
                onClick={() => setPendingImage(null)}
                className="absolute -top-1 -right-1 rounded-full bg-zinc-800 border border-white/20 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
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
              className="shrink-0 flex items-center justify-center h-11 w-9 rounded-lg border border-white/[0.08] bg-white/[0.04] text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/[0.08] transition-colors disabled:opacity-30"
              disabled={isSending}
              aria-label="Attach image"
            >
              <Paperclip className="size-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />
          </>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            dir="auto"
            className="flex-1 min-h-[44px] max-h-32 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-[11px] text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 disabled:opacity-50 transition-[border-color,box-shadow] resize-none leading-tight overflow-y-auto"
            disabled={isSending}
            autoComplete="off"
            spellCheck={false}
          />

          <Button
            type="submit"
            size="icon"
            className="shrink-0 h-11 w-11"
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

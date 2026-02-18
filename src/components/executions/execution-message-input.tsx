'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Loader2, Send, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { ExecutionStatus, Execution } from '@/lib/types';

// ---------------------------------------------------------------------------
// Claude Code built-in slash commands
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
  hasArgs?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/compact',      description: 'Compact conversation context', hasArgs: true },
  { name: '/clear',        description: 'Clear conversation history' },
  { name: '/cost',         description: 'Show token usage and cost' },
  { name: '/memory',       description: 'Open memory file editor' },
  { name: '/mcp',          description: 'Manage MCP server connections' },
  { name: '/permissions',  description: 'View and manage tool permissions' },
  { name: '/status',       description: 'Show account and system status' },
  { name: '/doctor',       description: 'Check system health' },
  { name: '/model',        description: 'Switch the AI model', hasArgs: true },
  { name: '/review',       description: 'Review a pull request' },
  { name: '/init',         description: 'Initialize project — create CLAUDE.md' },
  { name: '/bug',          description: 'Submit a bug report' },
  { name: '/help',         description: 'Show help and all commands' },
  { name: '/vim',          description: 'Toggle vim keybindings' },
  { name: '/terminal',     description: 'Open a terminal session' },
  { name: '/login',        description: 'Switch Anthropic account' },
  { name: '/logout',       description: 'Log out of current account' },
  { name: '/release-notes', description: 'View recent release notes' },
  { name: '/pr_comments',  description: 'View pull request comments', hasArgs: true },
  { name: '/exit',         description: 'Exit the current session' },
];

// ---------------------------------------------------------------------------
// SlashCommandPicker
// ---------------------------------------------------------------------------

interface SlashCommandPickerProps {
  commands: SlashCommand[]; // already-filtered list from parent
  activeIdx: number;
  onSelect: (cmd: SlashCommand) => void;
  onChangeActive: (idx: number) => void;
}

function SlashCommandPicker({ commands, activeIdx, onSelect, onChangeActive }: SlashCommandPickerProps) {
  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border border-white/[0.10] bg-[oklch(0.10_0_0)] shadow-2xl overflow-hidden">
      <div className="px-3 py-1.5 border-b border-white/[0.06]">
        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">
          Slash commands · ↑↓ navigate · ↵ select · Esc dismiss
        </span>
      </div>
      <ul className="max-h-48 overflow-auto" role="listbox">
        {commands.map((cmd, i) => (
          <li
            key={cmd.name}
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
            {cmd.hasArgs && (
              <span className="ml-auto text-muted-foreground/40 shrink-0 italic text-[10px]">+ args</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumeContext {
  taskId: string;
  agentId: string;
  capabilityId: string;
  parentExecutionId: string;
  sessionRef: string;
}

interface PendingImage {
  dataUrl: string;
  mimeType: string;
  data: string; // base64 without data URL prefix
}

interface ExecutionMessageInputProps {
  executionId: string;
  status?: ExecutionStatus;
  onSent?: (text: string) => void;
  sessionSlashCommands?: string[];
  resumeContext?: ResumeContext;
  onResumed?: (newExecutionId: string, userText: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 128) + 'px';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ExecutionMessageInput({
  executionId,
  status,
  onSent,
  sessionSlashCommands,
  resumeContext,
  onResumed,
}: ExecutionMessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isRunning = status === 'running';
  const isDisabled = !isRunning && !resumeContext;
  const isContinueMode = !isRunning && !!resumeContext;

  const allCommands = useMemo<SlashCommand[]>(() => {
    if (!sessionSlashCommands?.length) return SLASH_COMMANDS;
    const hardcodedMap = new Map(SLASH_COMMANDS.map((c) => [c.name.slice(1), c]));
    const sessionSet = new Set(sessionSlashCommands);
    const merged: SlashCommand[] = sessionSlashCommands.map((name) => {
      const known = hardcodedMap.get(name);
      return known ?? { name: `/${name}`, description: name.replace(/-/g, ' ') };
    });
    for (const cmd of SLASH_COMMANDS) {
      if (!sessionSet.has(cmd.name.slice(1))) merged.push(cmd);
    }
    return merged;
  }, [sessionSlashCommands]);

  const slashQuery = showPicker ? message.slice(1) : '';
  const filteredCommands = allCommands.filter((c) =>
    c.name.toLowerCase().includes(slashQuery.toLowerCase()),
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setMessage(val);
    autoGrow(e.target);
    if (val.startsWith('/') && !isContinueMode) {
      setShowPicker(true);
      setActiveIdx(0);
    } else {
      setShowPicker(false);
    }
  }

  const selectCommand = useCallback((cmd: SlashCommand) => {
    const insert = cmd.hasArgs ? `${cmd.name} ` : `${cmd.name}`;
    setMessage(insert);
    setShowPicker(false);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const len = insert.length;
        textareaRef.current.setSelectionRange(len, len);
        autoGrow(textareaRef.current);
      }
    });
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (showPicker && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (filteredCommands[activeIdx]) {
          e.preventDefault();
          selectCommand(filteredCommands[activeIdx]);
          return;
        }
      } else if (e.key === 'Escape') {
        setShowPicker(false);
        return;
      }
    }

    // Enter without Shift = submit; Shift+Enter = newline (default)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  }

  useEffect(() => {
    if (!showPicker) return;
    function handleClick(e: MouseEvent) {
      if (textareaRef.current && !textareaRef.current.closest('form')?.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPicker]);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, commaIdx);
      const data = dataUrl.slice(commaIdx + 1);
      const mimeType = meta.match(/:(.*?);/)?.[1] ?? 'image/png';
      setPendingImage({ dataUrl, mimeType, data });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function submitMessage() {
    const trimmed = message.trim();
    if (!trimmed || isSending || isDisabled) return;

    setShowPicker(false);
    setIsSending(true);
    try {
      if (isContinueMode && resumeContext) {
        // Session continuation: create a new execution with promptOverride
        const result = await apiFetch<ApiResponse<Execution>>('/api/executions', {
          method: 'POST',
          body: JSON.stringify({
            taskId: resumeContext.taskId,
            agentId: resumeContext.agentId,
            capabilityId: resumeContext.capabilityId,
            parentExecutionId: resumeContext.parentExecutionId,
            sessionRef: resumeContext.sessionRef,
            promptOverride: trimmed,
          }),
        });
        setMessage('');
        resetTextarea();
        onResumed?.(result.data.id, trimmed);
      } else {
        // Normal message to running execution
        const body: Record<string, unknown> = { message: trimmed };
        if (pendingImage) {
          body.image = { mimeType: pendingImage.mimeType, data: pendingImage.data };
        }
        await apiFetch(`/api/executions/${executionId}/message`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setMessage('');
        setPendingImage(null);
        resetTextarea();
        onSent?.(trimmed);
      }
    } catch {
      // transient; user can retry
    } finally {
      setIsSending(false);
    }
  }

  function resetTextarea() {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitMessage();
  }

  if (isDisabled) return null;

  return (
    <form
      onSubmit={handleSubmit}
      className="relative flex flex-col gap-0 border-t border-white/[0.07] bg-[oklch(0.09_0_0)] px-3 py-2.5"
    >
      {showPicker && filteredCommands.length > 0 && (
        <SlashCommandPicker
          commands={filteredCommands}
          activeIdx={activeIdx}
          onSelect={selectCommand}
          onChangeActive={setActiveIdx}
        />
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
        {/* Image upload — only in running mode */}
        {isRunning && (
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
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={isContinueMode ? 'Continue session…' : 'Message agent… or / for commands'}
          rows={1}
          className="flex-1 min-h-[44px] max-h-32 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-[11px] text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 disabled:opacity-50 transition-[border-color,box-shadow] resize-none leading-tight overflow-y-auto"
          disabled={isSending}
          autoComplete="off"
          spellCheck={false}
        />

        <Button
          type="submit"
          size="icon"
          className="shrink-0 h-11 w-11"
          disabled={!message.trim() || isSending}
          aria-label="Send message"
        >
          {isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </form>
  );
}

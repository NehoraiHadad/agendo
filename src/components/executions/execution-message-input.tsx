'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-types';
import type { ExecutionStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Claude Code built-in slash commands
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
  hasArgs?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/compact',      description: 'Compact conversation context (optional: focus instructions)', hasArgs: true },
  { name: '/clear',        description: 'Clear conversation history and start fresh' },
  { name: '/cost',         description: 'Show token usage and cost for this session' },
  { name: '/memory',       description: 'Open memory file editor' },
  { name: '/mcp',          description: 'Manage MCP server connections' },
  { name: '/permissions',  description: 'View and manage tool permissions' },
  { name: '/status',       description: 'Show account and system status' },
  { name: '/doctor',       description: 'Check system health and configuration' },
  { name: '/model',        description: 'Switch the AI model for this session', hasArgs: true },
  { name: '/review',       description: 'Review a pull request' },
  { name: '/init',         description: 'Initialize project — create CLAUDE.md' },
  { name: '/bug',          description: 'Submit a bug report to Anthropic' },
  { name: '/help',         description: 'Show help and all available commands' },
  { name: '/vim',          description: 'Toggle vim keybindings mode' },
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
  query: string;      // the text after "/"
  activeIdx: number;
  onSelect: (cmd: SlashCommand) => void;
  onChangeActive: (idx: number) => void;
}

function SlashCommandPicker({ query, activeIdx, onSelect, onChangeActive }: SlashCommandPickerProps) {
  const filtered = SLASH_COMMANDS.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-md border border-zinc-700 bg-zinc-900 shadow-lg overflow-hidden">
      <div className="px-2 py-1 border-b border-zinc-800">
        <span className="text-xs text-zinc-500">Slash commands · ↑↓ navigate · ↵ select · Esc dismiss</span>
      </div>
      <ul className="max-h-56 overflow-auto" role="listbox">
        {filtered.map((cmd, i) => (
          <li
            key={cmd.name}
            role="option"
            aria-selected={i === activeIdx}
            className={`flex items-baseline gap-3 px-3 py-1.5 cursor-pointer text-xs ${
              i === activeIdx ? 'bg-zinc-700' : 'hover:bg-zinc-800'
            }`}
            onMouseEnter={() => onChangeActive(i)}
            onClick={() => onSelect(cmd)}
          >
            <span className="font-mono text-zinc-100 shrink-0">{cmd.name}</span>
            <span className="text-zinc-500 truncate">{cmd.description}</span>
            {cmd.hasArgs && (
              <span className="ml-auto text-zinc-600 shrink-0 italic">+ args</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ExecutionMessageInputProps {
  executionId: string;
  status?: ExecutionStatus;
  onSent?: (text: string) => void;
  /** slash_commands from the system init event — merged with the hardcoded list */
  sessionSlashCommands?: string[];
}

export function ExecutionMessageInput({
  executionId,
  status,
  onSent,
  sessionSlashCommands,
}: ExecutionMessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isDisabled = status !== undefined && status !== 'running';

  // Merge hardcoded list with session commands from system init.
  // Session commands take precedence for ordering; descriptions from hardcoded list when available.
  const allCommands = useMemo<SlashCommand[]>(() => {
    if (!sessionSlashCommands?.length) return SLASH_COMMANDS;
    const hardcodedMap = new Map(SLASH_COMMANDS.map((c) => [c.name.slice(1), c]));
    const sessionSet = new Set(sessionSlashCommands);
    // Session commands first (in order), then any hardcoded not in session
    const merged: SlashCommand[] = sessionSlashCommands.map((name) => {
      const known = hardcodedMap.get(name);
      return known ?? { name: `/${name}`, description: name.replace(/-/g, ' ') };
    });
    for (const cmd of SLASH_COMMANDS) {
      if (!sessionSet.has(cmd.name.slice(1))) merged.push(cmd);
    }
    return merged;
  }, [sessionSlashCommands]);

  // Slash-command query: everything after the leading "/"
  const slashQuery = showPicker ? message.slice(1) : '';

  const filteredCommands = allCommands.filter((c) =>
    c.name.toLowerCase().includes(slashQuery.toLowerCase()),
  );

  // Watch message for leading "/"
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setMessage(val);
    if (val.startsWith('/')) {
      setShowPicker(true);
      setActiveIdx(0);
    } else {
      setShowPicker(false);
    }
  }

  const selectCommand = useCallback((cmd: SlashCommand) => {
    // Commands without args: insert as-is with trailing space for send readiness
    // Commands with args: insert with trailing space for user to append args
    const insert = cmd.hasArgs ? `${cmd.name} ` : `${cmd.name}`;
    setMessage(insert);
    setShowPicker(false);
    // Focus and move cursor to end
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        const len = insert.length;
        inputRef.current.setSelectionRange(len, len);
      }
    });
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showPicker || filteredCommands.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (showPicker && filteredCommands[activeIdx]) {
        e.preventDefault();
        selectCommand(filteredCommands[activeIdx]);
      }
    } else if (e.key === 'Escape') {
      setShowPicker(false);
    }
  }

  // Close picker if clicked outside
  useEffect(() => {
    if (!showPicker) return;
    function handleClick(e: MouseEvent) {
      if (inputRef.current && !inputRef.current.closest('form')?.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPicker]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isSending || isDisabled) return;

    setShowPicker(false);
    setIsSending(true);
    try {
      await apiFetch(`/api/executions/${executionId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: trimmed }),
      });
      setMessage('');
      onSent?.(trimmed);
    } catch {
      // transient; user can retry
    } finally {
      setIsSending(false);
    }
  }

  if (isDisabled) return null;

  return (
    <form
      onSubmit={handleSubmit}
      className="relative flex items-center gap-2 border-t border-zinc-700 bg-zinc-900 px-3 py-2"
    >
      {showPicker && filteredCommands.length > 0 && (
        <SlashCommandPicker
          query={slashQuery}
          activeIdx={activeIdx}
          onSelect={selectCommand}
          onChangeActive={setActiveIdx}
        />
      )}

      <input
        ref={inputRef}
        value={message}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Message agent… or / for commands"
        className="min-h-[44px] h-11 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50"
        disabled={isSending}
        autoComplete="off"
        spellCheck={false}
      />
      <Button
        type="submit"
        size="icon-xs"
        disabled={!message.trim() || isSending}
        aria-label="Send message"
      >
        {isSending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
      </Button>
    </form>
  );
}

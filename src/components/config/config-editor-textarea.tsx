'use client';

import { useRef, useEffect } from 'react';
import { Save, RotateCcw, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ConfigEditorTextareaProps {
  content: string;
  onChange: (content: string) => void;
  filePath: string | null;
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onRevert: () => void;
}

/** Derives a short display label from an absolute file path. */
function shortPath(filePath: string): string {
  const home = filePath.replace(/^\/home\/[^/]+/, '~');
  // Collapse /root/ → ~/
  return home.replace(/^\/root/, '~');
}

export function ConfigEditorTextarea({
  content,
  onChange,
  filePath,
  isDirty,
  isSaving,
  onSave,
  onRevert,
}: ConfigEditorTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep textarea focused when content changes externally (file load).
  useEffect(() => {
    if (filePath && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [filePath]);

  if (!filePath) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          {/* Decorative icon cluster */}
          <div className="relative mb-1">
            <div
              className="h-14 w-14 rounded-2xl flex items-center justify-center"
              style={{
                background:
                  'linear-gradient(135deg, oklch(0.18 0.02 260 / 0.6) 0%, oklch(0.12 0.01 260 / 0.3) 100%)',
                border: '1px solid oklch(0.7 0.18 280 / 0.08)',
                boxShadow: '0 8px 24px oklch(0 0 0 / 0.3)',
              }}
            >
              <FileText className="h-6 w-6 text-muted-foreground/20" />
            </div>
          </div>
          <p className="text-sm font-medium text-muted-foreground/40">
            Select a file from the tree to edit
          </p>
          <p className="text-xs text-muted-foreground/25 max-w-[220px]">
            Choose a scope and pick a config file on the left to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header bar */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{
          background: 'oklch(0.09 0 0)',
          borderColor: 'oklch(0.18 0 0)',
        }}
      >
        {/* File path */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText className="h-3.5 w-3.5 text-muted-foreground/35 shrink-0" />
          <span
            className="text-[11px] font-mono text-muted-foreground/55 truncate"
            title={filePath}
          >
            {shortPath(filePath)}
          </span>

          {/* Unsaved indicator */}
          {isDirty && (
            <span className="flex items-center gap-1 shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400/80" title="Unsaved changes" />
              <span className="text-[10px] text-amber-400/60 font-medium hidden sm:block">
                unsaved
              </span>
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRevert}
            disabled={!isDirty || isSaving}
            className={cn(
              'h-7 px-2.5 text-xs gap-1.5 border transition-colors',
              isDirty
                ? 'text-muted-foreground/60 border-white/[0.07] hover:text-foreground/70 hover:bg-white/[0.05] hover:border-white/[0.12]'
                : 'text-muted-foreground/25 border-white/[0.04] cursor-not-allowed',
            )}
            title="Revert to last saved (Escape)"
          >
            <RotateCcw className="h-3 w-3" />
            <span className="hidden sm:inline">Revert</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={onSave}
            disabled={!isDirty || isSaving}
            className={cn(
              'h-7 px-2.5 text-xs gap-1.5 border transition-colors',
              isDirty && !isSaving
                ? 'text-emerald-400 border-emerald-500/20 hover:text-emerald-300 hover:bg-emerald-500/10'
                : 'text-muted-foreground/25 border-white/[0.04] cursor-not-allowed',
            )}
            title="Save (Ctrl+S)"
          >
            {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            <span className="hidden sm:inline">{isSaving ? 'Saving…' : 'Save'}</span>
          </Button>
        </div>
      </div>

      {/* Editor body */}
      <div className="flex flex-1 min-h-0 relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={cn(
            'flex-1 w-full resize-none font-mono text-[12.5px] leading-relaxed',
            'px-4 py-3',
            'focus:outline-none',
            'text-foreground/80 placeholder:text-muted-foreground/25',
            'selection:bg-primary/20',
          )}
          style={{
            background: 'oklch(0.075 0 0)',
            fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
            tabSize: 2,
            caretColor: 'oklch(0.7 0.18 280)',
          }}
          placeholder="File is empty"
        />

        {/* Subtle syntax-like left gutter accent */}
        <div
          className="absolute left-0 top-0 bottom-0 w-px pointer-events-none"
          style={{ background: 'oklch(0.7 0.18 280 / 0.04)' }}
        />
      </div>
    </div>
  );
}

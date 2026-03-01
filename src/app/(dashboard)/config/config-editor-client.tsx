'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Settings, Loader2, AlertCircle } from 'lucide-react';
import { ConfigScopeSelector } from '@/components/config/config-scope-selector';
import { ConfigFileTree, type TreeNode } from '@/components/config/config-file-tree';
import { ConfigEditorTextarea } from '@/components/config/config-editor-textarea';
import { cn } from '@/lib/utils';

interface ProjectOption {
  id: string;
  name: string;
  rootPath: string;
}

/** Claude Code's fixed system prompt + 18+ built-in tools, present in every session. */
const SYSTEM_OVERHEAD = 15_000;

function fmtTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1)}K`;
}

/** Color-codes a total token count relative to a 200K Claude context window. */
function tokenOverheadColor(n: number): string {
  const pct = n / 200_000;
  if (pct > 0.15) return 'oklch(0.65 0.22 25 / 0.85)'; // orange — >15% of context
  if (pct > 0.05) return 'oklch(0.72 0.18 60 / 0.85)'; // yellow — 5–15%
  return 'oklch(0.65 0.15 140 / 0.75)'; // green — <5%
}

/** Returns true if the file path is inside a skills/ or commands/ directory. */
function isInvokeOnlyPath(filePath: string): boolean {
  return /[/\\](?:skills|commands)[/\\]/.test(filePath);
}

/**
 * Splits content into frontmatter length and body length.
 * Frontmatter is the YAML block between the first `---` pair.
 */
function splitFrontmatter(content: string): { frontmatterLen: number; bodyLen: number } {
  if (!content.startsWith('---')) return { frontmatterLen: 0, bodyLen: content.length };
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatterLen: 0, bodyLen: content.length };
  const frontmatterLen = endIdx + 4;
  return { frontmatterLen, bodyLen: content.length - frontmatterLen };
}

interface ConfigEditorClientProps {
  projects: ProjectOption[];
}

export function ConfigEditorClient({ projects }: ConfigEditorClientProps) {
  const [scope, setScope] = useState<string>('global');
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sum tokenEstimate across all root-level nodes. Directories already carry subtotals.
  const totalTokens = useMemo(
    () => tree.reduce((acc, node) => acc + (node.tokenEstimate ?? 0), 0),
    [tree],
  );

  // Live token estimates for the currently open file — updates as the user types.
  // For skills/commands, split into frontmatter (always loaded) and body (on invoke).
  const { liveTokenEstimate, liveInvokeEstimate } = useMemo(() => {
    if (!fileContent || !selectedFile)
      return { liveTokenEstimate: undefined, liveInvokeEstimate: undefined };
    if (isInvokeOnlyPath(selectedFile)) {
      const { frontmatterLen, bodyLen } = splitFrontmatter(fileContent);
      return {
        liveTokenEstimate: frontmatterLen > 0 ? Math.ceil(frontmatterLen / 4) : undefined,
        liveInvokeEstimate: bodyLen > 0 ? Math.ceil(bodyLen / 4) : undefined,
      };
    }
    const est = Math.ceil(fileContent.length / 4);
    return { liveTokenEstimate: est > 0 ? est : undefined, liveInvokeEstimate: undefined };
  }, [fileContent, selectedFile]);

  // Fetch file tree when scope changes.
  useEffect(() => {
    const controller = new AbortController();
    setIsLoadingTree(true);
    setTreeError(null);
    setSelectedFile(null);
    setFileContent('');
    setOriginalContent('');
    setIsDirty(false);

    const query = scope === 'global' ? 'scope=global' : `projectPath=${encodeURIComponent(scope)}`;

    fetch(`/api/config/tree?${query}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ data: TreeNode[] }>;
      })
      .then((body) => {
        setTree(body.data);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setTreeError('Failed to load file tree');
        console.error('[config] tree fetch failed', err);
      })
      .finally(() => setIsLoadingTree(false));

    return () => controller.abort();
  }, [scope]);

  // Fetch file content when a file is selected.
  const handleSelectFile = useCallback((path: string) => {
    setSelectedFile(path);
    setFileError(null);
    setSaveError(null);
    setIsLoadingFile(true);

    fetch(`/api/config/files?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ data: { content: string; path: string } }>;
      })
      .then((body) => {
        setFileContent(body.data.content);
        setOriginalContent(body.data.content);
        setIsDirty(false);
      })
      .catch((err) => {
        setFileError('Failed to load file content');
        console.error('[config] file fetch failed', err);
      })
      .finally(() => setIsLoadingFile(false));
  }, []);

  const handleContentChange = useCallback(
    (content: string) => {
      setFileContent(content);
      setIsDirty(content !== originalContent);
      setSaveError(null);
    },
    [originalContent],
  );

  const handleSave = useCallback(async () => {
    if (!selectedFile || !isDirty || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/config/files/write', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOriginalContent(fileContent);
      setIsDirty(false);
      // Refresh tree so token counts reflect the saved content.
      const query =
        scope === 'global' ? 'scope=global' : `projectPath=${encodeURIComponent(scope)}`;
      fetch(`/api/config/tree?${query}`)
        .then((r) => r.json() as Promise<{ data: TreeNode[] }>)
        .then((body) => setTree(body.data))
        .catch(() => {}); // Non-critical — stale counts are acceptable.
    } catch (err) {
      setSaveError('Failed to save file');
      console.error('[config] save failed', err);
    } finally {
      setIsSaving(false);
    }
  }, [selectedFile, isDirty, isSaving, fileContent, scope]);

  const handleRevert = useCallback(() => {
    setFileContent(originalContent);
    setIsDirty(false);
    setSaveError(null);
  }, [originalContent]);

  // Ctrl+S to save.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Page header */}
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] overflow-hidden shrink-0 mb-4 sm:mb-5">
        <div
          className="h-[2px] w-full"
          style={{
            background:
              'linear-gradient(90deg, oklch(0.7 0.18 280 / 0.6) 0%, oklch(0.6 0.2 260 / 0.1) 100%)',
          }}
        />
        <div className="flex items-center gap-3 px-4 py-3">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.15) 0%, oklch(0.6 0.2 260 / 0.08) 100%)',
              border: '1px solid oklch(0.7 0.18 280 / 0.12)',
            }}
          >
            <Settings className="h-4 w-4 text-primary/70" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-foreground/90">Config Editor</h1>
            <p className="text-[11px] text-muted-foreground/35 mt-0.5">
              Edit Claude configuration files across scopes
            </p>
          </div>

          {/* Session token overhead summary */}
          {totalTokens > 0 && (
            <div
              className="ml-auto shrink-0 text-right"
              title={`Total session baseline: ~${SYSTEM_OVERHEAD + totalTokens} tokens.\n~${SYSTEM_OVERHEAD} fixed (Claude system prompt + built-in tools) + ~${totalTokens} from your config files.\nTrimming config files frees up context for actual work.`}
            >
              <p
                className="text-sm font-mono font-semibold leading-none"
                style={{ color: tokenOverheadColor(SYSTEM_OVERHEAD + totalTokens) }}
              >
                {fmtTokens(SYSTEM_OVERHEAD + totalTokens)}
              </p>
              <p className="text-[10px] text-muted-foreground/25 mt-0.5 leading-none">
                ~15K system · {fmtTokens(totalTokens)} config
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex flex-col sm:flex-row flex-1 min-h-0 gap-3 sm:gap-0">
        {/* Left panel: scope selector + file tree */}
        <div
          className={cn(
            'flex flex-col shrink-0 rounded-xl border border-white/[0.06] overflow-hidden',
            'sm:w-64 sm:rounded-r-none sm:border-r-0',
            'h-56 sm:h-auto', // fixed height on mobile, full height on desktop
          )}
          style={{ background: 'oklch(0.08 0 0)' }}
        >
          {/* Scope selector header */}
          <div className="px-3 py-2.5 border-b shrink-0" style={{ borderColor: 'oklch(0.14 0 0)' }}>
            <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-2">
              Scope
            </p>
            <ConfigScopeSelector scope={scope} projects={projects} onChange={setScope} />
          </div>

          {/* File tree */}
          <div className="flex-1 overflow-y-auto min-h-0 py-1">
            {isLoadingTree ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/30" />
              </div>
            ) : treeError ? (
              <div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
                <AlertCircle className="h-4 w-4 text-red-400/50" />
                <p className="text-[11px] text-red-400/50">{treeError}</p>
              </div>
            ) : (
              <ConfigFileTree tree={tree} selectedPath={selectedFile} onSelect={handleSelectFile} />
            )}
          </div>
        </div>

        {/* Right panel: file editor */}
        <div
          className={cn(
            'flex flex-1 flex-col min-h-0 rounded-xl border border-white/[0.06] overflow-hidden',
            'sm:rounded-l-none',
          )}
          style={{ background: 'oklch(0.075 0 0)' }}
        >
          {isLoadingFile ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground/30">Loading file…</p>
              </div>
            </div>
          ) : fileError ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-center px-6">
                <AlertCircle className="h-5 w-5 text-red-400/50" />
                <p className="text-sm text-red-400/50">{fileError}</p>
                <button
                  type="button"
                  onClick={() => selectedFile && handleSelectFile(selectedFile)}
                  className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors underline underline-offset-2"
                >
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <ConfigEditorTextarea
              content={fileContent}
              onChange={handleContentChange}
              filePath={selectedFile}
              isDirty={isDirty}
              isSaving={isSaving}
              onSave={() => void handleSave()}
              onRevert={handleRevert}
              tokenEstimate={liveTokenEstimate}
              invokeTokenEstimate={liveInvokeEstimate}
            />
          )}

          {/* Save error toast-style banner */}
          {saveError && (
            <div
              className="flex items-center gap-2 px-3 py-2 border-t shrink-0"
              style={{
                background: 'oklch(0.15 0.04 20 / 0.6)',
                borderColor: 'oklch(0.5 0.15 20 / 0.2)',
              }}
            >
              <AlertCircle className="h-3.5 w-3.5 text-red-400/70 shrink-0" />
              <p className="text-xs text-red-400/70">{saveError}</p>
              <button
                type="button"
                onClick={() => setSaveError(null)}
                className="ml-auto text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

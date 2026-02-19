'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api-types';
import type { ApiResponse } from '@/lib/api-types';

interface MemoryData {
  global: string;
  project: string;
  projectPath: string | null;
}

interface MemoryEditorModalProps {
  /** e.g. "/api/sessions/xxx/memory" or "/api/executions/yyy/memory" */
  apiPath: string;
  open: boolean;
  onClose: () => void;
}

export function MemoryEditorModal({ apiPath, open, onClose }: MemoryEditorModalProps) {
  const [activeTab, setActiveTab] = useState<'global' | 'project'>('global');
  const [files, setFiles] = useState<{ global: string; project: string }>({
    global: '',
    project: '',
  });
  const [edited, setEdited] = useState<{ global: string; project: string }>({
    global: '',
    project: '',
  });
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    apiFetch<ApiResponse<MemoryData>>(apiPath)
      .then(({ data }) => {
        setFiles({ global: data.global, project: data.project });
        setEdited({ global: data.global, project: data.project });
        setProjectPath(data.projectPath);
      })
      .catch(() => setError('Failed to load memory files'))
      .finally(() => setLoading(false));
  }, [open, apiPath]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch(apiPath, {
        method: 'POST',
        body: JSON.stringify({ type: activeTab, content: edited[activeTab] }),
      });
      setFiles((prev) => ({ ...prev, [activeTab]: edited[activeTab] }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const isDirty = edited[activeTab] !== files[activeTab];

  const filePath =
    activeTab === 'global'
      ? '~/.claude/CLAUDE.md'
      : projectPath
        ? `${projectPath}/CLAUDE.md`
        : '(no project CLAUDE.md)';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Memory Files</DialogTitle>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b border-white/[0.08] -mt-2">
          {(['global', 'project'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                activeTab === tab
                  ? 'text-foreground border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'global' ? '~/.claude/CLAUDE.md' : 'Project CLAUDE.md'}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="py-4 text-center text-sm text-red-400">{error}</div>
        ) : (
          <textarea
            value={edited[activeTab]}
            onChange={(e) =>
              setEdited((prev) => ({ ...prev, [activeTab]: e.target.value }))
            }
            className="w-full h-64 font-mono text-xs bg-black/30 border border-white/[0.08] rounded-lg p-3 text-foreground resize-none focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
            placeholder={activeTab === 'project' && !projectPath ? 'No project path configured for this agent' : 'Empty — start typing...'}
            readOnly={activeTab === 'project' && !projectPath}
          />
        )}

        <p className="text-[10px] text-muted-foreground/40 -mt-1">{filePath}</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isDirty || saving || loading || (activeTab === 'project' && !projectPath)}
          >
            {saving && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
            {saved ? 'Saved!' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

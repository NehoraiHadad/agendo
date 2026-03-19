'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ContentionAlert } from '@/hooks/use-file-contention';
import { FileContentionDetail } from '@/components/sessions/file-contention-detail';

interface FileContentionAlertProps {
  alert: ContentionAlert;
  currentSessionId: string;
}

export function FileContentionAlert({ alert, currentSessionId }: FileContentionAlertProps) {
  const [open, setOpen] = useState(false);

  const isCritical = alert.severity === 'critical';
  const fileCount = alert.conflictingFiles.length;
  const label = isCritical
    ? `${fileCount} conflict${fileCount !== 1 ? 's' : ''}`
    : `${fileCount} file${fileCount !== 1 ? 's' : ''} at risk`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-1 border transition-colors ${
          isCritical
            ? 'text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/15'
            : 'text-amber-400 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15'
        }`}
        title={
          isCritical
            ? 'File contention — same branch overwrite risk'
            : 'File contention — merge conflict risk'
        }
      >
        <AlertTriangle className="size-3" />
        <span>{label}</span>
        {isCritical && (
          <span className="relative flex size-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full size-1.5 bg-red-400" />
          </span>
        )}
      </button>

      <FileContentionDetail
        alert={alert}
        currentSessionId={currentSessionId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

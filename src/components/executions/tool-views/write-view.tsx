'use client';

import { CopyButton } from '@/components/ui/copy-button';

interface WriteViewProps {
  input: {
    content?: string;
    new_file?: string;
    path?: string;
    file_path?: string;
  };
}

export function WriteView({ input }: WriteViewProps) {
  // Claude's Write tool may use different field names
  const content = input.content ?? input.new_file ?? '';
  const filePath = input.path ?? input.file_path ?? '';
  const lineCount = content.split('\n').length;

  return (
    <div className="rounded border border-white/[0.08] overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-white/[0.03] border-b border-white/[0.06] text-xs">
        {filePath && (
          <span className="font-mono text-foreground/80 truncate flex-1">
            {filePath}
          </span>
        )}
        <span className="text-muted-foreground/50">{lineCount} lines</span>
        <CopyButton text={content} />
      </div>
      <pre className="max-h-[40dvh] overflow-auto p-2 text-xs font-mono text-foreground/80 bg-[oklch(0.07_0_0)] whitespace-pre break-all">
        {content}
      </pre>
    </div>
  );
}

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
    <div className="rounded border border-zinc-700 overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-800 border-b border-zinc-700 text-xs">
        {filePath && (
          <span className="font-mono text-zinc-300 truncate flex-1">
            {filePath}
          </span>
        )}
        <span className="text-zinc-500">{lineCount} lines</span>
        <CopyButton text={content} />
      </div>
      <pre className="max-h-[40dvh] overflow-auto p-2 text-xs font-mono text-zinc-300 bg-zinc-950 whitespace-pre break-all">
        {content}
      </pre>
    </div>
  );
}

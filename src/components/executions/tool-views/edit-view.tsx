'use client';

import { DiffView } from './diff-view';
import { parseEditDiff } from '@/lib/diff-parser';

interface EditViewProps {
  input: {
    old_string?: string;
    old_content?: string;
    new_string?: string;
    new_content?: string;
    path?: string;
    file_path?: string;
  };
}

export function EditView({ input }: EditViewProps) {
  const oldStr = input.old_string ?? input.old_content ?? '';
  const newStr = input.new_string ?? input.new_content ?? '';
  const filePath = input.path ?? input.file_path;
  const parsedDiff = parseEditDiff(oldStr, newStr);

  return <DiffView parsedDiff={parsedDiff} filePath={filePath} />;
}

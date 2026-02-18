'use client';

import { EditView } from './edit-view';

interface MultiEditViewProps {
  input: {
    edits?: Array<{
      old_string?: string;
      new_string?: string;
      path?: string;
    }>;
    path?: string;
  };
}

export function MultiEditView({ input }: MultiEditViewProps) {
  const edits = input.edits ?? [];
  if (edits.length === 0) return null;

  return (
    <div className="space-y-2">
      {edits.map((edit, i) => (
        <EditView
          key={i}
          input={{
            old_string: edit.old_string,
            new_string: edit.new_string,
            path: edit.path ?? input.path,
          }}
        />
      ))}
    </div>
  );
}

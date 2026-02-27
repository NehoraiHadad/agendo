'use client';

import { SessionTable } from '@/components/sessions/session-table';
import { ImportSessionDialog } from '@/components/sessions/import/import-session-dialog';

export function SessionListClient() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <ImportSessionDialog />
      </div>
      <SessionTable />
    </div>
  );
}

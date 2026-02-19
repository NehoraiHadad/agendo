'use client';

import { SessionTable } from '@/components/sessions/session-table';

export function SessionListClient() {
  return (
    <div className="flex flex-col gap-6">
      <SessionTable />
    </div>
  );
}

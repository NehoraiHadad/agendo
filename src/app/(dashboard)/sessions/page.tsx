import { Suspense } from 'react';
import { SessionListClient } from './session-list-client';

export const metadata = { title: 'Sessions — agenDo' };

export default function SessionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Sessions</h1>
        <p className="text-sm text-muted-foreground mt-1">AI agent conversation sessions</p>
      </div>
      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading...</div>}>
        <SessionListClient />
      </Suspense>
    </div>
  );
}

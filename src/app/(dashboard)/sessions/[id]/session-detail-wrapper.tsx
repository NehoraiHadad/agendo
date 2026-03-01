'use client';

// `ssr: false` is removed in Next.js 16 App Router.
// useSyncExternalStore with a server snapshot of `false` is the
// React-idiomatic way to render nothing on the server and mount
// the real component only on the client — no effect, no setState.
import { useSyncExternalStore } from 'react';
import { SessionDetailClient } from './session-detail-client';
import type { Session } from '@/lib/types';

const emptySubscribe = () => () => {};

function useIsClient() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

interface Props {
  session: Session;
  agentName: string;
  agentSlug: string;
  agentBinaryPath: string;
  capLabel: string;
  taskTitle: string;
  projectName: string;
}

export function SessionDetailWrapper(props: Props) {
  const isClient = useIsClient();
  if (!isClient) return null;
  return <SessionDetailClient {...props} />;
}

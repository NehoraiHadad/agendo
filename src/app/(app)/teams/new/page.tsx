'use client';

import { useSyncExternalStore, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

/**
 * Team Build Canvas page — drag-and-drop team composer.
 *
 * React Flow requires browser APIs (ResizeObserver, DOM measurements),
 * so we lazy-load the canvas with ssr: false.
 *
 * Optional query params:
 *   ?taskId=xxx   — pre-link to a parent task
 *   ?projectId=xxx — pre-set project context
 */

const TeamBuildCanvasLoader = dynamic(
  () =>
    import('@/components/teams/team-build-canvas-wrapper').then((m) => m.TeamBuildCanvasWrapper),
  {
    ssr: false,
    loading: () => <TeamCanvasSkeleton />,
  },
);

const emptySubscribe = () => () => {};

function useIsClient() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

export default function TeamBuildPage() {
  const isClient = useIsClient();
  if (!isClient) return <TeamCanvasSkeleton />;

  return (
    <Suspense fallback={<TeamCanvasSkeleton />}>
      <TeamBuildInner />
    </Suspense>
  );
}

function TeamBuildInner() {
  const searchParams = useSearchParams();
  const taskId = searchParams.get('taskId') ?? undefined;
  const projectId = searchParams.get('projectId') ?? undefined;

  return <TeamBuildCanvasLoader taskId={taskId} projectId={projectId} />;
}

// ============================================================================
// Skeleton loader
// ============================================================================

function TeamCanvasSkeleton() {
  return (
    <div className="flex flex-col h-full bg-[#0a0a0f]">
      {/* Toolbar skeleton */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="h-6 w-[200px] bg-white/[0.04] rounded-md animate-pulse" />
          <div className="h-6 w-[100px] bg-white/[0.04] rounded-md animate-pulse" />
        </div>
        <div className="h-8 w-[130px] bg-purple-600/20 rounded-lg animate-pulse" />
      </div>

      {/* Content skeleton */}
      <div className="flex flex-1 min-h-0">
        {/* Palette skeleton */}
        <div className="w-[240px] border-r border-white/[0.06] p-3 space-y-2">
          <div className="h-4 w-16 bg-white/[0.04] rounded animate-pulse mb-3" />
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-white/[0.03] rounded-lg animate-pulse" />
          ))}
        </div>

        {/* Canvas skeleton */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-[#80809a] animate-pulse">Loading canvas...</div>
        </div>

        {/* Config panel skeleton */}
        <div className="w-[320px] border-l border-white/[0.06] p-4">
          <div className="h-4 w-24 bg-white/[0.04] rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

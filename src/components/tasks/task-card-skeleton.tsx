export function TaskCardSkeleton() {
  return (
    <div className="w-full animate-pulse rounded-md border bg-background p-3">
      <div className="h-4 w-3/4 rounded bg-muted" />
      <div className="mt-2 flex gap-2">
        <div className="h-5 w-16 rounded bg-muted" />
        <div className="h-5 w-12 rounded bg-muted" />
      </div>
      <div className="mt-1.5 h-3 w-full rounded bg-muted" />
    </div>
  );
}

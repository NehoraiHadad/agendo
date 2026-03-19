import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description?: string;
  /** Single action node rendered below the description. */
  action?: React.ReactNode;
  /**
   * Multiple action nodes — rendered in a flex row. Use when more than one
   * button is needed. If both `action` and `actions` are provided, `actions`
   * takes precedence.
   */
  actions?: React.ReactNode[];
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  actions,
  className,
}: EmptyStateProps) {
  const actionContent = actions ? (
    <div className="flex items-center justify-center gap-2">{actions}</div>
  ) : action ? (
    <div>{action}</div>
  ) : null;

  return (
    <div
      className={cn('flex flex-col items-center justify-center py-16 px-8 text-center', className)}
    >
      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 mb-5">
        <Icon className="h-6 w-6 text-muted-foreground/60" />
      </div>
      <h3 className="text-sm font-medium text-muted-foreground/70 mb-1">{title}</h3>
      {description && <p className="text-xs text-muted-foreground/40 max-w-sm">{description}</p>}
      {actionContent && <div className="mt-4">{actionContent}</div>}
    </div>
  );
}

import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-8 text-center', className)}>
      <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-4 mb-5">
        <Icon className="h-6 w-6 text-muted-foreground/60" />
      </div>
      <h3 className="text-sm font-medium text-muted-foreground/70 mb-1">{title}</h3>
      {description && <p className="text-xs text-muted-foreground/40 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

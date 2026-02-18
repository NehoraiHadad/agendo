import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'rounded-md animate-shimmer',
        className,
      )}
      style={{
        background: 'linear-gradient(90deg, oklch(1 0 0 / 0.03) 0%, oklch(1 0 0 / 0.08) 50%, oklch(1 0 0 / 0.03) 100%)',
        backgroundSize: '200% 100%',
      }}
      {...props}
    />
  );
}

export { Skeleton };

import { cn } from '@/lib/utils';

interface ErrorAlertProps {
  message: string | null | undefined;
  className?: string;
}

export function ErrorAlert({ message, className }: ErrorAlertProps) {
  if (!message) return null;
  return (
    <p
      className={cn(
        'text-xs text-red-400 bg-red-500/[0.08] border border-red-800/30 rounded-lg px-2.5 py-1.5',
        className,
      )}
    >
      {message}
    </p>
  );
}

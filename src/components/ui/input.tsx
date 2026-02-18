import * as React from 'react';

import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'bg-white/[0.04] border border-white/[0.08] placeholder:text-muted-foreground/50 h-9 w-full min-w-0 rounded-md px-3 py-1 text-base text-foreground transition-[color,box-shadow,border-color] outline-none disabled:pointer-events-none disabled:opacity-50 md:text-sm',
        'focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/30 focus-visible:ring-[3px]',
        'file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium',
        'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };

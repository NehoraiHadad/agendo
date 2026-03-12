'use client';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AuthStatusResult } from '@/hooks/use-agent-auth';
import { cn } from '@/lib/utils';

interface AgentAuthBadgeProps {
  status: AuthStatusResult | null;
  isLoading: boolean;
  className?: string;
}

function methodLabel(method: AuthStatusResult['method']): string {
  switch (method) {
    case 'env-var':
      return 'API Key';
    case 'credential-file':
      return 'CLI Login';
    case 'both':
      return 'Authenticated';
    default:
      return 'Not Configured';
  }
}

export function AgentAuthBadge({ status, isLoading, className }: AgentAuthBadgeProps) {
  if (isLoading) {
    return (
      <span
        className={cn('inline-flex h-5 w-20 rounded-full bg-white/[0.06] animate-pulse', className)}
        aria-label="Loading auth status"
      />
    );
  }

  if (!status) return null;

  const isAuth = status.isAuthenticated;
  const label = methodLabel(status.method);

  const badge = (
    <Badge
      variant={isAuth ? 'success' : 'destructive'}
      className={cn('cursor-default text-[10px] px-1.5 py-0', className)}
    >
      {label} {isAuth ? '✓' : '✗'}
    </Badge>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="max-w-64 space-y-2 p-3">
          <div className="space-y-1">
            {status.envVarDetails.map((v) => (
              <div key={v.name} className="flex items-center gap-1.5 text-xs">
                <span className={v.isSet ? 'text-emerald-400' : 'text-red-400'}>
                  {v.isSet ? '✓' : '✗'}
                </span>
                <span className="font-mono">{v.name}</span>
              </div>
            ))}
          </div>
          {status.authCommand && (
            <p className="text-xs text-balance">
              Run: <code className="font-mono bg-white/10 px-1 rounded">{status.authCommand}</code>
            </p>
          )}
          {status.homepage && (
            <a
              href={status.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline-offset-2 hover:underline block"
            >
              {status.displayName} docs
            </a>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

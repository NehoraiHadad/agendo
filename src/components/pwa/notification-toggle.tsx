'use client';

import { Bell, BellOff } from 'lucide-react';
import { useNotifications } from '@/hooks/use-notifications';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function NotificationToggle() {
  const { isSupported, permission, isSubscribed, isLoading, subscribe, unsubscribe } =
    useNotifications();

  if (!isSupported) return null;

  const handleClick = () => {
    if (isSubscribed) {
      void unsubscribe();
    } else {
      void subscribe();
    }
  };

  const label = isSubscribed ? 'Disable notifications' : 'Enable notifications';
  const isBlocked = permission === 'denied';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleClick}
          disabled={isLoading || isBlocked}
          aria-label={label}
          className={cn(
            'rounded-md p-1.5 transition-colors',
            isSubscribed
              ? 'text-primary hover:text-primary/80 hover:bg-white/[0.05]'
              : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.05]',
            (isLoading || isBlocked) && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isSubscribed ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {isBlocked ? 'Notifications blocked in browser settings' : label}
      </TooltipContent>
    </Tooltip>
  );
}

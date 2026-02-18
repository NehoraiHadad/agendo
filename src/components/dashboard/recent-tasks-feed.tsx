import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import type { RecentEvent } from '@/lib/services/dashboard-service';

interface RecentTasksFeedProps {
  events: RecentEvent[];
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  status_changed: 'bg-blue-500/15 text-blue-400 border border-blue-500/25',
  execution_created: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25',
  comment_added: 'bg-violet-500/15 text-violet-400 border border-violet-500/25',
  default: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25',
};

export function RecentTasksFeed({ events }: RecentTasksFeedProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[300px]">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent activity</p>
          ) : (
            <div className="relative space-y-2 pl-4 before:absolute before:left-1.5 before:top-1 before:bottom-1 before:w-px before:bg-white/[0.05]">
              {events.map((event) => (
                <div key={event.id} className="relative flex items-start justify-between gap-2 group">
                  <span className="absolute -left-4 top-1.5 h-2 w-2 rounded-full border-2 border-background bg-muted shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        className={`${EVENT_TYPE_COLORS[event.eventType] ?? EVENT_TYPE_COLORS.default} text-xs px-2 py-0.5 rounded-full font-medium`}
                      >
                        {event.eventType.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      Task {event.taskId.slice(0, 8)}... by {event.actorType}
                    </p>
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import type { RecentEvent } from '@/lib/services/dashboard-service';

interface RecentTasksFeedProps {
  events: RecentEvent[];
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  status_changed: 'bg-blue-100 text-blue-800',
  execution_created: 'bg-green-100 text-green-800',
  comment_added: 'bg-purple-100 text-purple-800',
  default: 'bg-zinc-100 text-zinc-800',
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
            <div className="space-y-3">
              {events.map((event) => (
                <div key={event.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        className={EVENT_TYPE_COLORS[event.eventType] ?? EVENT_TYPE_COLORS.default}
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

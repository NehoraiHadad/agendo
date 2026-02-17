'use client';

import { useTransition } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmTool } from '@/lib/actions/discovery-actions';
import type { DiscoveredTool } from '@/lib/discovery';

const TYPE_COLORS: Record<string, string> = {
  'ai-agent': 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  'cli-tool': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'admin-tool': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  'interactive-tui': 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  'daemon': 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
  'shell-util': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
};

interface DiscoveredToolCardProps {
  tool: DiscoveredTool;
  onConfirmed: (tool: DiscoveredTool) => void;
  onDismissed: (toolName: string) => void;
}

export function DiscoveredToolCard({ tool, onConfirmed, onDismissed }: DiscoveredToolCardProps) {
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      const result = await confirmTool(tool);
      if (result.success) {
        onConfirmed(tool);
      }
    });
  }

  return (
    <Card className={tool.isConfirmed ? 'opacity-60' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-semibold">{tool.name}</CardTitle>
          <div className="flex gap-1">
            <Badge
              variant="outline"
              className={TYPE_COLORS[tool.toolType] ?? ''}
            >
              {tool.toolType}
            </Badge>
            {tool.preset && (
              <Badge variant="default">Preset</Badge>
            )}
            {tool.isConfirmed && (
              <Badge variant="secondary">Confirmed</Badge>
            )}
          </div>
        </div>
        <CardDescription className="text-xs text-muted-foreground truncate">
          {tool.path}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-2">
        {tool.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">{tool.description}</p>
        )}
        {tool.version && (
          <p className="mt-1 text-xs text-muted-foreground">v{tool.version}</p>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        {!tool.isConfirmed && (
          <>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={isPending}
            >
              {isPending ? 'Confirming...' : 'Confirm'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDismissed(tool.name)}
              disabled={isPending}
            >
              Dismiss
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

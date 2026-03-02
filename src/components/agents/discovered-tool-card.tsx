'use client';

import { useState, useTransition } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmTool } from '@/lib/actions/discovery-actions';
import type { DiscoveredTool } from '@/lib/discovery';

const TYPE_COLORS: Record<string, string> = {
  'ai-agent': 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

interface DiscoveredToolCardProps {
  tool: DiscoveredTool;
  onConfirmed: (tool: DiscoveredTool) => void;
  onDismissed: (toolName: string) => void;
}

export function DiscoveredToolCard({ tool, onConfirmed, onDismissed }: DiscoveredToolCardProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleConfirm() {
    startTransition(async () => {
      setError(null);
      const result = await confirmTool(tool);
      if (result.success) {
        onConfirmed(tool);
      } else {
        setError(result.error ?? 'Failed to confirm tool');
      }
    });
  }

  return (
    <Card
      className={`rounded-xl border border-white/[0.06] bg-card p-4 hover:border-white/[0.12] transition-all duration-200 ${tool.isConfirmed ? 'opacity-60' : ''}`}
    >
      <CardHeader className="pb-2 p-0">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">{tool.name}</CardTitle>
          <div className="flex gap-1">
            <Badge
              variant="outline"
              className={`text-[10px] bg-white/[0.04] border border-white/[0.06] text-muted-foreground/70 rounded-full px-2 py-0.5 ${TYPE_COLORS[tool.toolType] ?? ''}`}
            >
              {tool.toolType}
            </Badge>
            {tool.preset && <Badge variant="default">Preset</Badge>}
            {tool.isConfirmed && <Badge variant="secondary">Confirmed</Badge>}
          </div>
        </div>
        <CardDescription className="text-xs text-muted-foreground/60 truncate">
          {tool.path}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-2 p-0 pt-2">
        {tool.description && (
          <p className="text-xs text-muted-foreground/60 line-clamp-2">{tool.description}</p>
        )}
        {tool.version && <p className="mt-1 text-xs text-muted-foreground/60">v{tool.version}</p>}
      </CardContent>
      <CardFooter className="flex-col items-start gap-2 p-0 pt-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!tool.isConfirmed && (
          <>
            <Button
              size="sm"
              className="bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 glow-sm"
              onClick={handleConfirm}
              disabled={isPending}
            >
              {isPending ? 'Confirming...' : 'Confirm'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground/60 hover:text-foreground"
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

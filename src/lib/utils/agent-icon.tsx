import { Bot, Sparkles, Brain, Code, type LucideIcon } from 'lucide-react';
import type { Agent } from '@/lib/types';

const LUCIDE_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  brain: Brain,
  code: Code,
  bot: Bot,
};

/**
 * Returns a React node for an agent's icon, derived from agent.metadata.
 * Falls back to a Bot icon if no icon metadata is present.
 *
 * @param agent - The agent whose icon to render
 * @param className - Optional CSS class for the icon element (defaults to "size-4")
 */
export function getAgentIcon(agent: Agent, className = 'size-4'): React.ReactNode {
  const meta = agent.metadata as { icon?: string; color?: string } | null;
  const iconName = meta?.icon?.toLowerCase();
  const color = meta?.color;
  const Icon = iconName ? LUCIDE_ICONS[iconName] : undefined;

  if (Icon) {
    return <Icon className={className} style={color ? { color } : undefined} />;
  }

  // Emoji fallback — used when the icon name is a short emoji string
  if (iconName && iconName.length <= 4) {
    return <span className="leading-none">{iconName}</span>;
  }

  return <Bot className={`${className} text-muted-foreground`} />;
}

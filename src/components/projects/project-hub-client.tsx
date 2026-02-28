'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight,
  Circle,
  MessageCircle,
  Play,
  Plus,
  Sparkles,
  Brain,
  Code,
  Bot,
  Camera,
  type LucideIcon,
} from 'lucide-react';
import { QuickLaunchDialog } from '@/components/sessions/quick-launch-dialog';
import { SnapshotsTab } from '@/components/snapshots/snapshots-tab';
import { Button } from '@/components/ui/button';
import type { Project, Task, Agent } from '@/lib/types';
import type { SessionWithAgent } from '@/lib/services/session-service';
import type { SessionStatus } from '@/lib/realtime/events';

const LUCIDE_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  brain: Brain,
  code: Code,
  bot: Bot,
};

const STATUS_CONFIG: Record<SessionStatus, { color: string; label: string; dot: string }> = {
  active: { color: 'text-blue-400', label: 'Active', dot: 'fill-blue-400' },
  awaiting_input: { color: 'text-emerald-400', label: 'Your turn', dot: 'fill-emerald-400' },
  idle: { color: 'text-zinc-400', label: 'Paused', dot: 'fill-zinc-500' },
  ended: { color: 'text-zinc-500', label: 'Ended', dot: 'fill-zinc-600' },
};

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

type TabId = 'conversations' | 'sessions' | 'tasks' | 'snapshots';

interface ProjectHubClientProps {
  project: Project;
  conversations: SessionWithAgent[];
  executionSessions: SessionWithAgent[];
  openTasks: Task[];
  agents: Agent[];
}

export function ProjectHubClient({
  project,
  conversations,
  executionSessions,
  openTasks,
  agents,
}: ProjectHubClientProps) {
  const [launchOpen, setLaunchOpen] = useState(false);
  const [defaultAgentId, setDefaultAgentId] = useState<string | undefined>();
  const [launchKind, setLaunchKind] = useState<'conversation' | 'execution'>('conversation');
  const [activeTab, setActiveTab] = useState<TabId>('conversations');
  const accentColor = project.color ?? '#6366f1';

  function openLaunch(agentId?: string, kind: 'conversation' | 'execution' = 'conversation') {
    setDefaultAgentId(agentId);
    setLaunchKind(kind);
    setLaunchOpen(true);
  }

  function getAgentIcon(agent: Agent, size = 'size-6'): React.ReactNode {
    const meta = agent.metadata as { icon?: string; color?: string } | null;
    const iconName = meta?.icon?.toLowerCase();
    const color = meta?.color;
    const LucideIcon = iconName ? LUCIDE_ICONS[iconName] : undefined;
    if (LucideIcon) {
      return <LucideIcon className={size} style={color ? { color } : undefined} />;
    }
    if (iconName && iconName.length <= 4)
      return <span className="text-2xl leading-none">{iconName}</span>;
    return <Bot className={`${size} text-muted-foreground`} />;
  }

  const tabs: { id: TabId; label: string; count: number; icon?: React.ElementType }[] = [
    { id: 'conversations', label: 'Conversations', count: conversations.length },
    { id: 'sessions', label: 'Sessions', count: executionSessions.length },
    { id: 'tasks', label: 'Tasks', count: openTasks.length },
    { id: 'snapshots', label: 'Snapshots', count: 0, icon: Camera },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Project header */}
      <div className="flex items-start gap-3">
        <div
          className="size-10 rounded-lg flex items-center justify-center text-xl shrink-0"
          style={{ backgroundColor: `${accentColor}22`, border: `1px solid ${accentColor}44` }}
        >
          {project.icon ?? <span style={{ color: accentColor }}>●</span>}
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{project.name}</h1>
          <p className="font-mono text-xs text-muted-foreground truncate mt-0.5">
            {project.rootPath}
          </p>
          {project.description && (
            <p className="text-sm text-muted-foreground/80 mt-1">{project.description}</p>
          )}
        </div>
      </div>

      {/* Agent launchers */}
      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
          New Conversation
        </h2>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active agents found.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => openLaunch(agent.id, 'conversation')}
                className="flex flex-col items-center gap-1.5 px-5 py-4 rounded-xl border border-white/[0.08] bg-card hover:border-white/[0.2] hover:bg-card/80 transition-colors text-sm font-medium min-w-[100px]"
              >
                <span className="flex items-center justify-center size-7">
                  {getAgentIcon(agent)}
                </span>
                <span className="text-xs text-muted-foreground">{agent.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Tabs */}
      <div className="border-b border-white/[0.06]">
        <nav className="flex gap-0 -mb-px" aria-label="Project tabs">
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-white/[0.1]'
                }`}
              >
                {TabIcon && <TabIcon className="size-3.5" />}
                {tab.label}
                {tab.count > 0 && (
                  <span className="ml-0.5 text-xs text-muted-foreground/60">({tab.count})</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'conversations' && (
        <ConversationsTab
          conversations={conversations}
          onNewConversation={() => openLaunch(undefined, 'conversation')}
        />
      )}
      {activeTab === 'sessions' && <SessionsTab sessions={executionSessions} />}
      {activeTab === 'tasks' && <TasksTab tasks={openTasks} projectId={project.id} />}
      {activeTab === 'snapshots' && <SnapshotsTab projectId={project.id} />}

      <QuickLaunchDialog
        projectId={project.id}
        open={launchOpen}
        defaultAgentId={defaultAgentId}
        defaultKind={launchKind}
        onOpenChange={setLaunchOpen}
      />
    </div>
  );
}

function ConversationsTab({
  conversations,
  onNewConversation,
}: {
  conversations: SessionWithAgent[];
  onNewConversation: () => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="text-center py-12">
        <MessageCircle className="size-10 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground mb-4">
          No conversations yet. Start one to brainstorm, plan, or explore.
        </p>
        <Button variant="outline" size="sm" onClick={onNewConversation}>
          <Plus className="size-3.5 mr-1.5" />
          New Conversation
        </Button>
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {conversations.map((session) => {
        const cfg = STATUS_CONFIG[session.status as SessionStatus] ?? STATUS_CONFIG.ended;
        return (
          <li key={session.id}>
            <Link
              href={`/sessions/${session.id}`}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors group"
            >
              <MessageCircle className="size-4 shrink-0 text-muted-foreground/50" />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">
                  {session.title ? (
                    <span className="font-medium">{session.title}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {session.initialPrompt
                        ? session.initialPrompt.slice(0, 60) +
                          (session.initialPrompt.length > 60 ? '...' : '')
                        : session.id.slice(0, 8)}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  {session.agentName}
                  <span className="mx-1.5">·</span>
                  <span suppressHydrationWarning>
                    {formatDistanceToNow(session.createdAt, { addSuffix: true })}
                  </span>
                </p>
              </div>
              <Circle className={`size-2 shrink-0 ${cfg.dot}`} />
              <span className={`text-xs shrink-0 ${cfg.color}`}>{cfg.label}</span>
              <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SessionsTab({ sessions }: { sessions: SessionWithAgent[] }) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-12">
        <Play className="size-10 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">
          No execution sessions yet. Create a task and assign an agent to start.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {sessions.map((session) => {
        const cfg = STATUS_CONFIG[session.status as SessionStatus] ?? STATUS_CONFIG.ended;
        return (
          <li key={session.id}>
            <Link
              href={`/sessions/${session.id}`}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors group"
            >
              <Play className="size-4 shrink-0 text-muted-foreground/50" />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">
                  {session.title ? (
                    <span className="font-medium">{session.title}</span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">
                      {session.id.slice(0, 8)}
                    </span>
                  )}
                  {session.agentName && (
                    <span className="text-muted-foreground/60 ml-2 text-xs">
                      {session.agentName}
                    </span>
                  )}
                </p>
                {session.taskTitle && (
                  <p className="text-xs text-muted-foreground/60 truncate mt-0.5">
                    {session.taskTitle}
                  </p>
                )}
              </div>
              <Circle className={`size-2 shrink-0 ${cfg.dot}`} />
              <span className={`text-xs shrink-0 ${cfg.color}`}>{cfg.label}</span>
              <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function TasksTab({ tasks, projectId }: { tasks: Task[]; projectId: string }) {
  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <Link
          href={`/tasks?project=${projectId}`}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          Open task board <ArrowRight className="size-3" />
        </Link>
      </div>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No open tasks.</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 px-3 py-2 rounded-lg">
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{task.title}</p>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {TASK_STATUS_LABELS[task.status] ?? task.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

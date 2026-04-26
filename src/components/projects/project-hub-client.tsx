'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight,
  Circle,
  FileText,
  FolderOpen,
  MessageCircle,
  Play,
  Plus,
  Camera,
  ListTodo,
  Server,
  Trash2,
} from 'lucide-react';
import { getAgentIcon } from '@/lib/utils/agent-icon';
import { QuickLaunchDialog } from '@/components/sessions/quick-launch-dialog';
import { SnapshotsTab } from '@/components/snapshots/snapshots-tab';
import { ProjectMcpConfig } from '@/components/mcp/project-mcp-config';
import { Button } from '@/components/ui/button';
import type { Project, Task, Agent, McpServer, ProjectMcpServer, Plan } from '@/lib/types';
import type { SessionListItem } from '@/lib/services/session-service';
import type { SessionStatus } from '@/lib/realtime/events';
import { SESSION_STATUS_CONFIG } from '@/lib/utils/session-status-config';

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

type TabId = 'conversations' | 'sessions' | 'tasks' | 'snapshots' | 'plans' | 'mcp';

interface ProjectMcpOverride extends ProjectMcpServer {
  mcpServer: McpServer;
}

interface ProjectHubClientProps {
  project: Project;
  freeChats: SessionListItem[];
  taskSessions: SessionListItem[];
  openTasks: Task[];
  agents: Agent[];
  allMcpServers: McpServer[];
  mcpOverrides: ProjectMcpOverride[];
  plans: Plan[];
}

export function ProjectHubClient({
  project,
  freeChats,
  taskSessions,
  openTasks,
  agents,
  allMcpServers,
  mcpOverrides,
  plans,
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

  const tabs: { id: TabId; label: string; count: number; icon: React.ElementType }[] = [
    { id: 'conversations', label: 'Chats', count: freeChats.length, icon: MessageCircle },
    { id: 'sessions', label: 'Sessions', count: taskSessions.length, icon: Play },
    { id: 'tasks', label: 'Tasks', count: openTasks.length, icon: ListTodo },
    { id: 'plans', label: 'Plans', count: plans.length, icon: FileText },
    { id: 'snapshots', label: 'Snapshots', count: 0, icon: Camera },
    { id: 'mcp', label: 'MCP', count: allMcpServers.length, icon: Server },
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
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold truncate">{project.name}</h1>
          <p className="font-mono text-xs text-muted-foreground truncate mt-0.5">
            {project.rootPath}
          </p>
          {project.description && (
            <p className="text-sm text-muted-foreground/80 mt-1">{project.description}</p>
          )}
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          title={`Browse ${project.name} files`}
        >
          <Link
            href={`/files?dir=${encodeURIComponent(project.rootPath)}`}
            aria-label={`Browse ${project.name} files`}
          >
            <FolderOpen className="size-4" />
            <span className="hidden sm:inline">Browse files</span>
          </Link>
        </Button>
      </div>

      {/* Agent launchers */}
      <section className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                className="flex flex-col items-center gap-1.5 px-5 py-4 rounded-xl border border-white/[0.08] bg-card hover:border-white/[0.2] hover:bg-card/80 transition-colors text-sm font-medium min-w-[100px] min-h-[72px]"
              >
                <span className="flex items-center justify-center size-7">
                  {getAgentIcon(agent, 'size-6')}
                </span>
                <span className="text-xs text-muted-foreground">{agent.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Tabs */}
      <div className="border-b border-white/[0.06]">
        <nav
          className="flex gap-0 -mb-px py-1 overflow-x-auto overflow-y-visible scrollbar-none"
          aria-label="Project tabs"
        >
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                data-guide={`project-${tab.id}-tab`}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 min-h-[44px] ${
                  activeTab === tab.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-white/[0.1]'
                }`}
              >
                <TabIcon className="size-3.5 shrink-0" />
                <span className="hidden sm:inline">{tab.label}</span>
                {tab.count > 0 && (
                  <span className="text-xs text-muted-foreground/60 tabular-nums">
                    <span className="sm:hidden">{tab.count}</span>
                    <span className="hidden sm:inline">({tab.count})</span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'conversations' && (
        <ConversationsTab
          conversations={freeChats}
          onNewConversation={() => openLaunch(undefined, 'conversation')}
        />
      )}
      {activeTab === 'sessions' && <SessionsTab sessions={taskSessions} />}
      {activeTab === 'tasks' && <TasksTab tasks={openTasks} projectId={project.id} />}
      {activeTab === 'snapshots' && <SnapshotsTab projectId={project.id} />}
      {activeTab === 'plans' && <PlansTab plans={plans} projectId={project.id} />}
      {activeTab === 'mcp' && (
        <ProjectMcpConfig
          projectId={project.id}
          allServers={allMcpServers}
          overrides={mcpOverrides}
        />
      )}

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
  conversations: SessionListItem[];
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
        const cfg =
          SESSION_STATUS_CONFIG[session.status as SessionStatus] ?? SESSION_STATUS_CONFIG.ended;
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
              <Circle className={`size-2 shrink-0 ${cfg.dotFill}`} />
              <span className={`text-xs shrink-0 ${cfg.textColor}`}>{cfg.label}</span>
              <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SessionsTab({ sessions }: { sessions: SessionListItem[] }) {
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
        const cfg =
          SESSION_STATUS_CONFIG[session.status as SessionStatus] ?? SESSION_STATUS_CONFIG.ended;
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
              <Circle className={`size-2 shrink-0 ${cfg.dotFill}`} />
              <span className={`text-xs shrink-0 ${cfg.textColor}`}>{cfg.label}</span>
              <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const PLAN_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-zinc-800 text-zinc-400' },
  ready: { label: 'Ready', className: 'bg-blue-900/40 text-blue-400' },
  executing: { label: 'Executing', className: 'bg-amber-900/40 text-amber-400' },
  done: { label: 'Done', className: 'bg-emerald-900/40 text-emerald-400' },
  archived: { label: 'Archived', className: 'bg-zinc-800 text-zinc-500' },
};

function PlansTab({ plans, projectId: _projectId }: { plans: Plan[]; projectId: string }) {
  if (plans.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="size-10 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No plans yet.</p>
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {plans.map((plan) => {
        const badge = PLAN_STATUS_BADGE[plan.status] ?? PLAN_STATUS_BADGE.draft;
        return (
          <li key={plan.id} className="group/row flex items-center gap-1">
            <Link
              href={`/plans/${plan.id}`}
              className="flex items-center gap-3 flex-1 min-w-0 px-3 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors group"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground/40" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{plan.title}</p>
                <p className="text-xs text-muted-foreground/50 mt-0.5" suppressHydrationWarning>
                  {formatDistanceToNow(plan.createdAt, { addSuffix: true })}
                </p>
              </div>
              <span
                className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${badge.className}`}
              >
                {badge.label}
              </span>
              <ArrowRight className="size-3.5 text-muted-foreground/30 group-hover:text-muted-foreground shrink-0 transition-colors" />
            </Link>
            {plan.status === 'done' && (
              <button
                type="button"
                title="Remove integration"
                onClick={() => {
                  const name = plan.title.replace(/^Integrate[:\s]+/i, '').trim();
                  void fetch(`/api/integrations/${encodeURIComponent(name)}`, {
                    method: 'DELETE',
                  });
                }}
                className="p-2 rounded-md text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover/row:opacity-100 shrink-0"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
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

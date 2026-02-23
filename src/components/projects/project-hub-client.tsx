'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Circle, ExternalLink } from 'lucide-react';
import { QuickLaunchDialog } from '@/components/sessions/quick-launch-dialog';
import type { Project, Task, Agent } from '@/lib/types';
import type { SessionWithAgent } from '@/lib/services/session-service';
import type { SessionStatus } from '@/lib/realtime/events';

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

interface ProjectHubClientProps {
  project: Project;
  recentSessions: SessionWithAgent[];
  openTasks: Task[];
  agents: Agent[];
}

export function ProjectHubClient({
  project,
  recentSessions,
  openTasks,
  agents,
}: ProjectHubClientProps) {
  const [launchOpen, setLaunchOpen] = useState(false);
  const [defaultAgentId, setDefaultAgentId] = useState<string | undefined>();
  const accentColor = project.color ?? '#6366f1';

  function openLaunch(agentId?: string) {
    setDefaultAgentId(agentId);
    setLaunchOpen(true);
  }

  function getAgentIcon(agent: Agent): string {
    const meta = agent.metadata as { icon?: string } | null;
    return meta?.icon ?? '🤖';
  }

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
          Launch Agent
        </h2>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active agents found.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => openLaunch(agent.id)}
                className="flex flex-col items-center gap-1.5 px-5 py-4 rounded-xl border border-white/[0.08] bg-card hover:border-white/[0.2] hover:bg-card/80 transition-colors text-sm font-medium min-w-[100px]"
              >
                <span className="text-2xl leading-none">{getAgentIcon(agent)}</span>
                <span className="text-xs text-muted-foreground">{agent.name}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => openLaunch()}
              className="flex flex-col items-center gap-1.5 px-5 py-4 rounded-xl border border-dashed border-white/[0.08] hover:border-white/[0.2] transition-colors text-sm min-w-[100px]"
            >
              <span className="text-2xl leading-none text-muted-foreground">+</span>
              <span className="text-xs text-muted-foreground">Pick agent</span>
            </button>
          </div>
        )}
      </section>

      {/* Recent sessions */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent Sessions
          </h2>
          <Link
            href="/sessions"
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            View all <ExternalLink className="size-3" />
          </Link>
        </div>
        {recentSessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sessions yet. Launch an agent above.</p>
        ) : (
          <ul className="space-y-1">
            {recentSessions.map((session) => {
              const cfg = STATUS_CONFIG[session.status as SessionStatus] ?? STATUS_CONFIG.ended;
              return (
                <li key={session.id}>
                  <Link
                    href={`/sessions/${session.id}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.04] transition-colors group"
                  >
                    <Circle className={`size-2 shrink-0 ${cfg.dot}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">
                        <span className="font-mono text-xs text-muted-foreground mr-2">
                          {session.id.slice(0, 8)}
                        </span>
                        {session.agentName}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{session.taskTitle}</p>
                    </div>
                    <span className={`text-xs shrink-0 ${cfg.color}`}>{cfg.label}</span>
                    <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Open tasks */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Tasks ({openTasks.length} open)
          </h2>
          <Link
            href={`/tasks?project=${project.id}`}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            Open task board <ArrowRight className="size-3" />
          </Link>
        </div>
        {openTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open tasks.</p>
        ) : (
          <ul className="space-y-1">
            {openTasks.map((task) => (
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
      </section>

      <QuickLaunchDialog
        projectId={project.id}
        open={launchOpen}
        defaultAgentId={defaultAgentId}
        onOpenChange={setLaunchOpen}
      />
    </div>
  );
}

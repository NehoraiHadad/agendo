'use client';

import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';

interface WelcomeCardProps {
  agentCount: number;
  projectCount: number;
}

export function WelcomeCard({ agentCount, projectCount }: WelcomeCardProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">Welcome to Agendo</h2>
          <p className="text-muted-foreground max-w-md">
            Your self-hosted dashboard for managing AI coding agents. Let&apos;s get you set up.
          </p>
        </div>

        <div className="flex flex-col gap-4 w-full max-w-sm">
          <Step
            number={1}
            title="Agent CLIs"
            done={agentCount > 0}
            description={
              agentCount > 0
                ? `${agentCount} agent${agentCount !== 1 ? 's' : ''} discovered`
                : undefined
            }
          >
            {agentCount === 0 && (
              <div className="mt-2 text-xs text-muted-foreground space-y-1">
                <p>
                  These are AI coding assistants that Agendo orchestrates. Install at least one:
                </p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>Claude: npm i -g @anthropic-ai/claude-code</li>
                  <li>Codex: npm i -g @openai/codex</li>
                  <li>Gemini: npm i -g @google/gemini-cli</li>
                </ul>
                <p>Then run: pnpm db:seed</p>
              </div>
            )}
          </Step>
          <Step
            number={2}
            title="Create a project"
            done={projectCount > 0}
            description={
              projectCount > 0
                ? `${projectCount} project${projectCount !== 1 ? 's' : ''} created`
                : 'Link a code repository to organize tasks'
            }
            href="/projects"
          />
          <Step
            number={3}
            title="Create your first task"
            done={false}
            description="Open the Kanban board and add a task"
            href="/board"
          />
        </div>

        <div className="flex gap-3">
          <Link
            href="/projects?new=1"
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + New Project
          </Link>
          <Link
            href="/board"
            className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            + New Task
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function Step({
  number,
  title,
  done,
  description,
  href,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  description?: string;
  href?: string;
  children?: React.ReactNode;
}) {
  const content = (
    <div className="flex items-start gap-3 rounded-lg border p-4 text-left">
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
          done
            ? 'bg-green-500/15 text-green-600 dark:text-green-400'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {done ? '\u2713' : number}
      </div>
      <div className="space-y-0.5">
        <p className="font-medium leading-none">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
    </div>
  );

  if (href && !done) {
    return (
      <Link href={href} className="block transition-opacity hover:opacity-80">
        {content}
      </Link>
    );
  }

  return content;
}

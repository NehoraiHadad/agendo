'use client';

import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';

interface WelcomeCardProps {
  agentCount: number;
}

export function WelcomeCard({ agentCount }: WelcomeCardProps) {
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
                : 'Install claude, codex, or gemini and run pnpm db:seed'
            }
          />
          <Step
            number={2}
            title="Create a project"
            done={false}
            description="Link a code repository to organize tasks"
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
}: {
  number: number;
  title: string;
  done: boolean;
  description: string;
  href?: string;
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
        <p className="text-sm text-muted-foreground">{description}</p>
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

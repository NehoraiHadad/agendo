import { notFound } from 'next/navigation';
import { getExecutionById } from '@/lib/services/execution-service';
import { TerminalPageClient } from './terminal-page-client';

interface TerminalPageProps {
  params: Promise<{ id: string }>;
}

export default async function TerminalPage({ params }: TerminalPageProps) {
  const { id } = await params;

  let execution;
  try {
    execution = await getExecutionById(id);
  } catch {
    notFound();
  }

  if (!execution.tmuxSessionName) {
    notFound();
  }

  return (
    <TerminalPageClient
      executionId={execution.id}
      agentName={execution.agent.name}
      capabilityLabel={execution.capability.label}
    />
  );
}

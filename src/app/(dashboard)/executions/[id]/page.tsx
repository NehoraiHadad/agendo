import { notFound } from 'next/navigation';
import { getExecutionById } from '@/lib/services/execution-service';
import { ExecutionDetailClient } from './execution-detail-client';

interface ExecutionDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ExecutionDetailPage({ params }: ExecutionDetailPageProps) {
  const { id } = await params;

  let execution;
  try {
    execution = await getExecutionById(id);
  } catch {
    notFound();
  }

  return <ExecutionDetailClient execution={execution} />;
}

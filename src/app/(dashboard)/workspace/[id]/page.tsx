export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { getWorkspace } from '@/lib/services/workspace-service';
import { WorkspaceClient } from './workspace-client';

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Validate UUID format before hitting the DB
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) notFound();

  const workspace = await getWorkspace(id).catch(() => null);
  if (!workspace) notFound();

  return <WorkspaceClient workspace={workspace} />;
}

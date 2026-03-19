import { requireFound } from '@/lib/api-handler';
import { createGetByIdRoute } from '@/lib/api-routes';
import { getArtifact } from '@/lib/services/artifact-service';

async function getArtifactOrThrow(id: string) {
  const artifact = await getArtifact(id);
  return requireFound(artifact, 'Artifact', id);
}

export const GET = createGetByIdRoute(getArtifactOrThrow, 'Artifact');

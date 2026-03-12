import * as path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getAgentById } from '@/lib/services/agent-service';
import { getAuthConfig, writeEnvVarToEcosystem } from '@/lib/services/agent-auth-service';
import { BadRequestError } from '@/lib/errors';

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Agent');
    const agent = await getAgentById(id);
    const binaryName = path.basename(agent.binaryPath);
    const config = getAuthConfig(binaryName);

    if (!config) {
      throw new BadRequestError('No auth config for this agent', { binaryName });
    }

    const body: unknown = await req.json();
    if (!body || typeof body !== 'object') {
      throw new BadRequestError('Request body must be a JSON object');
    }

    const { envVar, value } = body as Record<string, unknown>;

    if (typeof envVar !== 'string' || !envVar) {
      throw new BadRequestError('envVar is required and must be a string');
    }
    if (typeof value !== 'string' || !value) {
      throw new BadRequestError('value is required and must be a non-empty string');
    }

    // Security: only allow env vars explicitly listed for this agent
    if (!config.envVars.includes(envVar)) {
      throw new BadRequestError('Invalid env var for this agent', {
        envVar,
        allowed: config.envVars,
      });
    }

    await writeEnvVarToEcosystem(envVar, value);
    return NextResponse.json({ success: true });
  },
);

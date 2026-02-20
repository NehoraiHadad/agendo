import path from 'node:path';
import { NextRequest } from 'next/server';
import { getAgentById } from '@/lib/services/agent-service';
import { enqueueAnalysis, getAnalysisJob } from '@/lib/worker/queue';
import type { AICapabilitySuggestion } from '@/lib/actions/capability-actions';

// POST — enqueue analysis via pg-boss worker, return jobId immediately
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const agent = await getAgentById(id);
  const toolName = path.basename(agent.binaryPath);

  const jobId = await enqueueAnalysis({
    agentId: id,
    binaryPath: agent.binaryPath,
    toolName,
  });

  return Response.json({ jobId });
}

// GET — poll job status from pg-boss
export async function GET(
  req: NextRequest,
  { params: _params }: { params: Promise<{ id: string }> },
) {
  const jobId = req.nextUrl.searchParams.get('job');
  if (!jobId) return Response.json({ status: 'pending' });

  const job = await getAnalysisJob(jobId);
  if (!job) return Response.json({ status: 'pending' });

  if (job.state === 'completed') {
    // Worker returns { suggestions: [...] }
    const output = job.output as { suggestions?: AICapabilitySuggestion[] } | null;
    const suggestions = output?.suggestions ?? [];
    return Response.json({ status: 'done', suggestions });
  }

  if (job.state === 'failed') {
    const output = job.output as { message?: string } | string | null;
    const error =
      typeof output === 'string'
        ? output
        : (output as { message?: string } | null)?.message ?? 'Analysis failed';
    return Response.json({ status: 'error', error });
  }

  // created / active / retry → still pending
  return Response.json({ status: 'pending' });
}

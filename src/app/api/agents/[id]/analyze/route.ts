import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getAgentById } from '@/lib/services/agent-service';
import { enqueueAnalysis, getAnalysisJob } from '@/lib/worker/queue';
import type { AICapabilitySuggestion } from '@/lib/actions/capability-analysis-action';

// POST — enqueue analysis via pg-boss worker, return jobId immediately
export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const agent = await getAgentById(id);
    const toolName = path.basename(agent.binaryPath);

    const jobId = await enqueueAnalysis({
      agentId: id,
      binaryPath: agent.binaryPath,
      toolName,
    });

    return NextResponse.json({ jobId });
  },
);

// GET — poll job status from pg-boss
export const GET = withErrorBoundary(
  async (req: NextRequest, { params: _params }: { params: Promise<Record<string, string>> }) => {
    const jobId = req.nextUrl.searchParams.get('job');
    if (!jobId) return NextResponse.json({ status: 'pending' });

    const job = await getAnalysisJob(jobId);
    if (!job) return NextResponse.json({ status: 'pending' });

    if (job.state === 'completed') {
      // Worker returns { suggestions: [...] }
      const output = job.output as { suggestions?: AICapabilitySuggestion[] } | null;
      const suggestions = output?.suggestions ?? [];
      return NextResponse.json({ status: 'done', suggestions });
    }

    if (job.state === 'failed') {
      const output = job.output as { message?: string } | string | null;
      const error =
        typeof output === 'string'
          ? output
          : ((output as { message?: string } | null)?.message ?? 'Analysis failed');
      return NextResponse.json({ status: 'error', error });
    }

    // created / active / retry → still pending
    return NextResponse.json({ status: 'pending' });
  },
);

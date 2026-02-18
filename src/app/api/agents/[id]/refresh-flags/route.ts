import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getAgentById, updateAgentParsedFlags } from '@/lib/services/agent-service';
import { getHelpText, quickParseHelp } from '@/lib/discovery/schema-extractor';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const agent = await getAgentById(id);
    const helpText = await getHelpText(agent.binaryPath);
    if (!helpText) {
      return NextResponse.json({ data: { parsedFlags: [] } });
    }
    const schema = quickParseHelp(helpText);
    await updateAgentParsedFlags(id, schema.options);
    return NextResponse.json({ data: { parsedFlags: schema.options } });
  },
);

import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import {
  listCapabilities,
  createCapability,
  type CapabilityFilters,
} from '@/lib/services/capability-service';

type RouteContext = { params: Promise<Record<string, string>> };

// ---------------------------------------------------------------------------
// GET /api/agents/:id/capabilities?interactionMode=prompt&supportStatus=verified&isEnabled=true
// ---------------------------------------------------------------------------

export const GET = withErrorBoundary(async (req: NextRequest, { params }: RouteContext) => {
  const { id } = await params;
  assertUUID(id, 'Agent');

  const url = new URL(req.url);
  const filters: CapabilityFilters = {};

  const mode = url.searchParams.get('interactionMode');
  if (mode === 'template' || mode === 'prompt') {
    filters.interactionMode = mode;
  }

  const status = url.searchParams.get('supportStatus');
  if (status === 'verified' || status === 'untested' || status === 'unsupported') {
    filters.supportStatus = status;
  }

  const enabled = url.searchParams.get('isEnabled');
  if (enabled === 'true') filters.isEnabled = true;
  else if (enabled === 'false') filters.isEnabled = false;

  const data = await listCapabilities(id, filters);
  return NextResponse.json({ data });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/capabilities
// ---------------------------------------------------------------------------

const createCapabilitySchema = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    description: z.string().nullable().optional(),
    source: z
      .enum([
        'manual',
        'builtin',
        'preset',
        'scan_help',
        'scan_completion',
        'scan_fig',
        'scan_mcp',
        'scan_man',
        'llm_generated',
      ])
      .optional(),
    interactionMode: z.enum(['template', 'prompt']).optional(),
    commandTokens: z.array(z.string()).nullable().optional(),
    promptTemplate: z.string().nullable().optional(),
    argsSchema: z.record(z.unknown()).optional(),
    requiresApproval: z.boolean().optional(),
    isEnabled: z.boolean().optional(),
    dangerLevel: z.number().int().min(0).max(3).optional(),
    timeoutSec: z.number().int().min(1).max(86400).optional(),
    maxOutputBytes: z.number().int().min(1).optional(),
    supportStatus: z.enum(['verified', 'untested', 'unsupported']).optional(),
    providerNotes: z.string().nullable().optional(),
  })
  .strict();

export const POST = withErrorBoundary(async (req: NextRequest, { params }: RouteContext) => {
  const { id } = await params;
  assertUUID(id, 'Agent');

  const body = createCapabilitySchema.parse(await req.json());
  const data = await createCapability({ ...body, agentId: id });
  return NextResponse.json({ data }, { status: 201 });
});

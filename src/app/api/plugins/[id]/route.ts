import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { NotFoundError } from '@/lib/errors';
import {
  getPlugin,
  setPluginEnabled,
  updateConfig,
} from '@/lib/services/plugin-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const plugin = await getPlugin(id);
    if (!plugin) throw new NotFoundError('Plugin', id);
    return NextResponse.json({ data: plugin });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();

    const plugin = await getPlugin(id);
    if (!plugin) throw new NotFoundError('Plugin', id);

    if (typeof body.enabled === 'boolean') {
      await setPluginEnabled(id, body.enabled);
    }

    if (body.config && typeof body.config === 'object') {
      await updateConfig(id, body.config as Record<string, unknown>);
    }

    const updated = await getPlugin(id);
    return NextResponse.json({ data: updated });
  },
);

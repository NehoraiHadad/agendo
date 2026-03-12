import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertUUID } from '@/lib/api-handler';
import { getAgentById } from '@/lib/services/agent-service';
import { getAuthConfig } from '@/lib/services/agent-auth-service';
import { AppError, BadRequestError, NotFoundError } from '@/lib/errors';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

function sseEvent(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<Record<string, string>> },
): Promise<NextResponse | Response> {
  // Pre-flight: validate agent and auth config before opening the stream
  let credentialPaths: string[];
  let authCommand: string;

  try {
    const { id } = await params;
    assertUUID(id, 'Agent');
    const agent = await getAgentById(id);
    const binaryName = path.basename(agent.binaryPath);
    const config = getAuthConfig(binaryName);

    if (!config) {
      throw new BadRequestError('No auth config for this agent', { binaryName });
    }

    credentialPaths = config.credentialPaths;
    authCommand = config.authCommand;
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json(err.toJSON(), { status: err.statusCode });
    }
    if (err instanceof z.ZodError) {
      const notFound = new NotFoundError('Agent');
      return NextResponse.json(notFound.toJSON(), { status: 404 });
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }

  // Pre-flight passed — open the SSE stream
  const capturedCredentialPaths = credentialPaths;
  const capturedAuthCommand = authCommand;

  const stream = new ReadableStream({
    start(controller) {
      const [cmd, ...args] = capturedAuthCommand.split(' ');
      const proc = spawn(cmd, args, {
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        controller.close();
      }

      function handleOutput(text: string) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          controller.enqueue(sseEvent({ type: 'url', url: urlMatch[1] }));
        }
      }

      proc.stdout?.on('data', (chunk: Buffer) => handleOutput(chunk.toString('utf-8')));
      proc.stderr?.on('data', (chunk: Buffer) => handleOutput(chunk.toString('utf-8')));

      // Poll for a credential file every 2 seconds
      const pollInterval = setInterval(() => {
        const hasFile = capturedCredentialPaths.some((p) => {
          try {
            return fs.existsSync(p);
          } catch {
            return false;
          }
        });

        if (hasFile) {
          controller.enqueue(sseEvent({ type: 'success' }));
          clearInterval(pollInterval);
          clearTimeout(timeout);
          proc.kill();
          close();
        }
      }, 2000);

      // Timeout after 5 minutes
      const timeout = setTimeout(() => {
        clearInterval(pollInterval);
        controller.enqueue(
          sseEvent({ type: 'error', message: 'Authentication timed out after 5 minutes' }),
        );
        proc.kill();
        close();
      }, 300_000);

      proc.on('close', (code: number | null) => {
        clearTimeout(timeout);
        clearInterval(pollInterval);
        if (!closed) {
          if (code === 0) {
            controller.enqueue(sseEvent({ type: 'success' }));
          } else if (code !== null) {
            controller.enqueue(
              sseEvent({ type: 'error', message: `Process exited with code ${code}` }),
            );
          }
          close();
        }
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

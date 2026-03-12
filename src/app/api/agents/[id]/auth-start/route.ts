import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertUUID } from '@/lib/api-handler';
import { getAgentById } from '@/lib/services/agent-service';
import { getAuthConfig, setRunningAuthProcess } from '@/lib/services/agent-auth-service';
import { AppError, BadRequestError, NotFoundError } from '@/lib/errors';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

/** Patterns that indicate the CLI is waiting for user input (e.g. an authorization code) */
const INPUT_PROMPT_PATTERNS = [
  /paste.*(?:code|token)/i,
  /authorization\s*code/i,
  /enter.*(?:code|token|key)/i,
  /verification\s*code/i,
];

function sseEvent(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<Record<string, string>> },
): Promise<NextResponse | Response> {
  // Pre-flight: validate agent and auth config before opening the stream
  let credentialPaths: string[];
  let authCommand: string;
  let agentId: string;

  try {
    const { id } = await params;
    agentId = id;
    assertUUID(id, 'Agent');
    const agent = await getAgentById(id);
    const binaryName = path.basename(agent.binaryPath);
    const config = getAuthConfig(binaryName);

    if (!config) {
      throw new BadRequestError('No auth config for this agent', { binaryName });
    }

    if (config.noCliAuth) {
      throw new BadRequestError(
        `${config.displayName} has no CLI auth command. It authenticates via browser on first interactive run.`,
        { binaryName },
      );
    }

    // Support optional provider/method for multi-provider agents (e.g. OpenCode)
    const body = (await req.json().catch(() => ({}))) as {
      provider?: string;
      method?: string;
    };

    credentialPaths = config.credentialPaths;

    if (body.provider && body.method) {
      // Build command with -p and -m flags to skip interactive TUI picker
      authCommand = `${config.authCommand} -p "${body.provider}" -m "${body.method}"`;
    } else {
      authCommand = config.authCommand;
    }
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
  const capturedAgentId = agentId;

  const stream = new ReadableStream({
    start(controller) {
      const [cmd, ...args] = capturedAuthCommand.split(' ');
      const proc = spawn(cmd, args, {
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'], // stdin is pipe so we can send auth codes
      });

      // Register the process so auth-input can pipe data to it
      setRunningAuthProcess(capturedAgentId, proc);

      let closed = false;
      let urlSent = false;
      let inputPromptSent = false;

      function close() {
        if (closed) return;
        closed = true;
        controller.close();
      }

      function handleOutput(text: string) {
        // Detect OAuth URLs
        const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch && !urlSent) {
          urlSent = true;
          controller.enqueue(sseEvent({ type: 'url', url: urlMatch[1] }));
        }

        // Detect input prompts (e.g. "Paste the authorization code here:")
        if (!inputPromptSent) {
          const isInputPrompt = INPUT_PROMPT_PATTERNS.some((p) => p.test(text));
          if (isInputPrompt) {
            inputPromptSent = true;
            // Clean up the prompt text for display
            // eslint-disable-next-line no-control-regex
            const ansiPattern = /\x1B\[[0-9;]*m/g;
            const promptText = text
              .replace(/[┌│└◆●▪▫]/g, '')
              .replace(ansiPattern, '')
              .replace(/\[?\?25[lh]\]?/g, '')
              .trim();
            controller.enqueue(sseEvent({ type: 'input_needed', prompt: promptText }));
          }
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

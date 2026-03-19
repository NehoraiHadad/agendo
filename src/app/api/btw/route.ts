import { NextRequest } from 'next/server';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveCliPath, stripClaudeEnv } from '@/lib/worker/adapters/build-sdk-options';
import { getErrorMessage } from '@/lib/utils/error-utils';

const BTW_SYSTEM_PROMPT = `You are answering a quick side question. The user is asking about something related to the conversation you can see in your history.

Constraints:
- Answer directly and concisely
- You have NO tools — cannot read files, run commands, or take actions
- If you don't know the answer from the conversation context, say so
- Do not offer to investigate or look things up`;

type NdjsonLine =
  | { type: 'init'; btwSessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool-start'; toolName: string; toolUseId: string }
  | { type: 'tool-end'; toolUseId: string; summary?: string }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string };

function encodeLine(line: NdjsonLine): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(line) + '\n');
}

export const POST = async (req: NextRequest): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { question, claudeSessionId, btwSessionId } = body as {
    question?: string;
    claudeSessionId?: string;
    btwSessionId?: string;
  };

  if (!question || typeof question !== 'string' || question.trim() === '') {
    return new Response(JSON.stringify({ error: 'Missing required field: question' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!claudeSessionId || typeof claudeSessionId !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing required field: claudeSessionId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Build query options depending on whether this is the first question or a follow-up.
       * First question: fork the original session so its history stays unmodified.
       * Follow-up: resume the previously forked btw session directly.
       */
      const isFirstQuestion = !btwSessionId;

      const sdkQuery = query({
        prompt: question,
        options: {
          ...(isFirstQuestion
            ? {
                resume: claudeSessionId,
                forkSession: true,
                systemPrompt: BTW_SYSTEM_PROMPT,
              }
            : {
                resume: btwSessionId,
              }),
          allowedTools: [],
          pathToClaudeCodeExecutable: resolveCliPath(),
          env: stripClaudeEnv(process.env),
        },
      });

      let forkSessionId: string | null = null;
      let fullText = '';
      let initSent = false;

      try {
        for await (const message of sdkQuery as AsyncIterable<SDKMessage>) {
          // Extract the forked session ID from the init event (first question only).
          if (message.type === 'system' && message.subtype === 'init') {
            forkSessionId = message.session_id;
            if (!initSent) {
              controller.enqueue(encodeLine({ type: 'init', btwSessionId: forkSessionId }));
              initSent = true;
            }
            continue;
          }

          // For follow-up questions the init event carries the resumed session ID.
          // Emit init once with whatever session_id arrives if we haven't yet.
          if (!initSent && 'session_id' in message && typeof message.session_id === 'string') {
            forkSessionId = message.session_id;
            controller.enqueue(encodeLine({ type: 'init', btwSessionId: forkSessionId }));
            initSent = true;
          }

          // Stream assistant text deltas and tool_use blocks as they arrive.
          if (message.type === 'assistant') {
            for (const part of message.message.content) {
              if (part.type === 'text') {
                controller.enqueue(encodeLine({ type: 'text', content: part.text }));
                fullText += part.text;
              } else if (part.type === 'tool_use') {
                controller.enqueue(
                  encodeLine({ type: 'tool-start', toolName: part.name, toolUseId: part.id }),
                );
              }
            }
            continue;
          }

          // tool_progress — a tool is still running; emit tool-start to (re)surface it.
          if (message.type === 'tool_progress') {
            controller.enqueue(
              encodeLine({
                type: 'tool-start',
                toolName: message.tool_name,
                toolUseId: message.tool_use_id,
              }),
            );
            continue;
          }

          // tool_use_summary — one or more tools completed; emit tool-end for each.
          if (message.type === 'tool_use_summary') {
            for (const toolUseId of message.preceding_tool_use_ids) {
              controller.enqueue(
                encodeLine({ type: 'tool-end', toolUseId, summary: message.summary }),
              );
            }
            continue;
          }

          // The result message carries the canonical final text.
          if (message.type === 'result' && 'result' in message) {
            fullText = message.result;
          }
        }

        controller.enqueue(encodeLine({ type: 'done', fullText }));
      } catch (err) {
        const message = getErrorMessage(err);
        controller.enqueue(encodeLine({ type: 'error', message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
};

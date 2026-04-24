/**
 * Terminal replay frames for the Claude Explore demo session.
 * Session ID: 77777777-7777-4777-a777-777777777777
 *
 * ~60 second arc, 42 frames.
 * Narrative: User watches Claude explore the codebase, reading the SSE hook,
 * running grep, checking the proxy, running tests, and writing notes.
 */

import type { TerminalFrame } from '@/lib/demo/terminal-scheduler';

// ANSI helpers (no alternate-screen escapes, no cursor positioning)
const ESC = '\x1b';
const P = `${ESC}[36m$${ESC}[0m `;
const GREEN = (s: string): string => `${ESC}[32m${s}${ESC}[0m`;
const RED = (s: string): string => `${ESC}[31m${s}${ESC}[0m`;
const CYAN = (s: string): string => `${ESC}[36m${s}${ESC}[0m`;
const BOLD = (s: string): string => `${ESC}[1m${s}${ESC}[0m`;
const DIM = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;

export const claudeExploreFrames: TerminalFrame[] = [
  // 1. Resume command
  {
    atMs: 0,
    data: `${P}claude --resume 77777777-7777-4777-a777-777777777777\r\n`,
  },

  // 2. Resume banner
  {
    atMs: 300,
    data: `${CYAN(BOLD('Claude Code v1.2.0'))} ${DIM('resumed session 77777777')}\r\n\r\n`,
  },

  // 3. Read use-session-stream.ts
  {
    atMs: 800,
    data: `${P}cat src/hooks/use-session-stream.ts | head -30\r\n`,
  },

  // 4a. Output chunk: imports
  {
    atMs: 1200,
    data:
      `${DIM('// src/hooks/use-session-stream.ts')}\r\n` +
      `${CYAN('import')} { useEffect, useRef } ${CYAN('from')} ${GREEN("'react'")}\r\n` +
      `${CYAN('import')} { useSessionStore } ${CYAN('from')} ${GREEN("'@/lib/store/session-store'")}\r\n` +
      `${CYAN('import')} ${CYAN('type')} { AgendoEvent } ${CYAN('from')} ${GREEN("'@/lib/types/events'")}\r\n`,
  },

  // 4b. Output chunk: hook signature
  {
    atMs: 1400,
    data:
      `\r\n` +
      `${CYAN('export')} ${CYAN('function')} ${BOLD('useSessionStream')}(sessionId: ${CYAN('string')}) {\r\n` +
      `  ${CYAN('const')} lastEventIdRef = useRef<${CYAN('string')} | ${CYAN('null')}>(${CYAN('null')})\r\n` +
      `  ${CYAN('const')} esRef = useRef<EventSource | ${CYAN('null')}>(${CYAN('null')})\r\n`,
  },

  // 4c. Output chunk: useEffect body
  {
    atMs: 1600,
    data:
      `\r\n` +
      `  useEffect(() => {\r\n` +
      `    ${CYAN('const')} url = ${GREEN('`/api/sessions/${sessionId}/events`')}\r\n` +
      `    ${CYAN('const')} source = ${CYAN('new')} EventSource(url)\r\n` +
      `    esRef.current = source\r\n` +
      `    source.onmessage = (e) => {\r\n` +
      `      lastEventIdRef.current = e.lastEventId\r\n` +
      `      ${CYAN('const')} ev: AgendoEvent = JSON.parse(e.data)\r\n` +
      `      useSessionStore.getState().addEvent(sessionId, ev)\r\n` +
      `    }\r\n`,
  },

  // 4d. Output chunk: error handler + close
  {
    atMs: 1800,
    data:
      `    source.onerror = () => {\r\n` +
      `      setTimeout(() => {\r\n` +
      `        esRef.current = ${CYAN('new')} EventSource(\r\n` +
      `          ${GREEN('`${url}?from=${lastEventIdRef.current ?? 0}`')}\r\n` +
      `        )\r\n` +
      `      }, ${GREEN('3000')})\r\n` +
      `    }\r\n` +
      `    return () => source.close()\r\n` +
      `  }, [sessionId])\r\n` +
      `}\r\n`,
  },

  // 5. grep lastEventId
  {
    atMs: 3500,
    data: `${P}grep -rn "lastEventId" src/\r\n`,
  },

  // 6a. grep results
  {
    atMs: 3900,
    data:
      `${CYAN('src/hooks/use-session-stream.ts')}:${GREEN('18')}:      lastEventIdRef.current = e.lastEventId\r\n` +
      `${CYAN('src/hooks/use-session-stream.ts')}:${GREEN('25')}:          ${GREEN('`${url}?from=${lastEventIdRef.current ?? 0}`')}\r\n`,
  },

  // 6b. more grep results
  {
    atMs: 4100,
    data:
      `${CYAN('src/app/api/sessions/[id]/events/route.ts')}:${GREEN('12')}:  const lastEventId = req.headers.get(${GREEN("'last-event-id'")})\r\n` +
      `${CYAN('src/lib/api/create-sse-proxy.ts')}:${GREEN('35')}:  if (lastEventId) workerUrl.searchParams.set(${GREEN("'from'")}, lastEventId)\r\n`,
  },

  // 7. ls api directory
  {
    atMs: 5500,
    data: `${P}ls src/lib/api/\r\n`,
  },

  // 8. directory listing
  {
    atMs: 5700,
    data: `${CYAN('api-handler.ts')}  ${CYAN('create-sse-proxy.ts')}  ${CYAN('worker-client.ts')}\r\n`,
  },

  // 9. cat proxy file
  {
    atMs: 7000,
    data: `${P}cat src/lib/api/create-sse-proxy.ts | head -40\r\n`,
  },

  // 10a. proxy code chunk 1
  {
    atMs: 7300,
    data:
      `${DIM('// src/lib/api/create-sse-proxy.ts')}\r\n` +
      `${CYAN('interface')} SSEProxyOptions {\r\n` +
      `  workerBase: ${CYAN('string')}\r\n` +
      `  sessionId:  ${CYAN('string')}\r\n` +
      `  lastEventId: ${CYAN('string')} | ${CYAN('null')}\r\n` +
      `}\r\n` +
      `\r\n` +
      `${CYAN('export')} ${CYAN('function')} ${BOLD('createSSEProxyHandler')}(\r\n` +
      `  opts: SSEProxyOptions\r\n` +
      `): Response {\r\n`,
  },

  // 10b. proxy code chunk 2
  {
    atMs: 7700,
    data:
      `  ${CYAN('const')} { workerBase, sessionId, lastEventId } = opts\r\n` +
      `  ${CYAN('const')} workerUrl = ${CYAN('new')} URL(\r\n` +
      `    ${GREEN('`/sessions/${sessionId}/events`')}, workerBase\r\n` +
      `  )\r\n` +
      `  ${CYAN('if')} (lastEventId) {\r\n` +
      `    workerUrl.searchParams.set(${GREEN("'from'")}, lastEventId)\r\n` +
      `  }\r\n`,
  },

  // 10c. proxy code chunk 3
  {
    atMs: 8100,
    data:
      `  ${CYAN('const')} stream = ${CYAN('new')} ReadableStream({\r\n` +
      `    ${CYAN('async')} start(controller) {\r\n` +
      `      ${CYAN('const')} res = ${CYAN('await')} fetch(workerUrl.toString())\r\n` +
      `      ${CYAN('if')} (!res.body) { controller.close(); ${CYAN('return')} }\r\n` +
      `      ${CYAN('for')} ${CYAN('await')} (${CYAN('const')} chunk ${CYAN('of')} res.body) {\r\n` +
      `        controller.enqueue(chunk)\r\n` +
      `      }\r\n` +
      `      controller.close()\r\n` +
      `    }\r\n` +
      `  })\r\n` +
      `  ${CYAN('return')} ${CYAN('new')} Response(stream, {\r\n` +
      `    headers: { ${GREEN("'Content-Type'")}: ${GREEN("'text/event-stream'")} },\r\n` +
      `  })\r\n` +
      `}\r\n`,
  },

  // 11. prompt after reading
  {
    atMs: 12000,
    data: `\r\n`,
  },

  // 12. run tests
  {
    atMs: 14000,
    data: `${P}pnpm vitest run src/hooks/__tests__/use-session-stream.test.ts\r\n`,
  },

  // 13a. vitest banner
  {
    atMs: 14500,
    data: `\r\n${BOLD(' RUN ')}  src/hooks/__tests__/use-session-stream.test.ts\r\n\r\n`,
  },

  // 13b. test 1
  {
    atMs: 15200,
    data: ` ${GREEN('✓')} reconnects with lastEventId on error ${DIM('(43ms)')}\r\n`,
  },

  // 13c. test 2
  {
    atMs: 16400,
    data: ` ${GREEN('✓')} forwards events to session store ${DIM('(12ms)')}\r\n`,
  },

  // 13d. test 3
  {
    atMs: 17800,
    data: ` ${GREEN('✓')} cleans up EventSource on unmount ${DIM('(8ms)')}\r\n`,
  },

  // 13e. summary
  {
    atMs: 19200,
    data:
      `\r\n` +
      ` ${BOLD(GREEN('Test Files'))}  ${GREEN('1 passed')} ${DIM('(1)')}\r\n` +
      `      ${BOLD(GREEN('Tests'))}  ${GREEN('3 passed')} ${DIM('(3)')}\r\n` +
      `   ${DIM('Duration')}  ${DIM('812ms (transform 94ms, setup 11ms, tests 63ms)')}\r\n\r\n`,
  },

  // 14. prompt after tests
  {
    atMs: 20000,
    data: `\r\n`,
  },

  // 15. try reading notes file
  {
    atMs: 23000,
    data: `${P}cat planning/reconnect-notes.md\r\n`,
  },

  // 16. file not found
  {
    atMs: 23300,
    data: RED('cat: planning/reconnect-notes.md: No such file or directory\r\n'),
  },

  // 17. agent writes the file (simulated)
  {
    atMs: 25000,
    data: `${DIM('(agent writing planning/reconnect-notes.md…)')}\r\n`,
  },

  // 18a. write output
  {
    atMs: 27000,
    data:
      `${GREEN('# SSE Reconnect Architecture')}\r\n` +
      `\r\n` +
      `Three properties ensure zero-loss catchup on reconnect:\r\n`,
  },

  // 18b.
  {
    atMs: 27300,
    data:
      `1. Monotonic integer IDs on every Worker event\r\n` +
      `2. Transparent Next.js proxy forwards IDs verbatim\r\n` +
      `3. Log-based replay from Worker on ?from= reconnect\r\n`,
  },

  // 18c.
  {
    atMs: 27600,
    data: `\r\n${DIM('planning/reconnect-notes.md written (512 bytes)')}\r\n`,
  },

  // 19. typecheck
  {
    atMs: 30000,
    data: `${P}pnpm typecheck\r\n`,
  },

  // 20a. typecheck running
  {
    atMs: 30400,
    data: `${DIM('> tsc --noEmit')}\r\n`,
  },

  // 20b. typecheck complete
  {
    atMs: 35000,
    data: `${GREEN('No errors found.')}\r\n`,
  },

  // 21. idle prompt
  {
    atMs: 50000,
    data: `\r\n`,
  },

  // 22. prompt at 55s
  {
    atMs: 55000,
    data: `${P}`,
  },

  // 23. final prompt at 60s
  {
    atMs: 60000,
    data: `\r\n${P}`,
  },
];

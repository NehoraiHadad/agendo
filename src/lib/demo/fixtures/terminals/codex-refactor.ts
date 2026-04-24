/**
 * Terminal replay frames for the Codex Refactor demo session.
 * Session ID: 88888888-8888-4888-a888-888888888888
 *
 * ~45 second arc, 30 frames.
 * Narrative: Codex did a refactor; terminal shows the diff, test run, typecheck, and commit.
 */

import type { TerminalFrame } from '@/lib/demo/terminal-scheduler';

// ANSI helpers
const ESC = '\x1b';
const P = `${ESC}[36m$${ESC}[0m `;
const GREEN = (s: string): string => `${ESC}[32m${s}${ESC}[0m`;
const RED = (s: string): string => `${ESC}[31m${s}${ESC}[0m`;
const YELLOW = (s: string): string => `${ESC}[33m${s}${ESC}[0m`;
const CYAN = (s: string): string => `${ESC}[36m${s}${ESC}[0m`;
const BOLD = (s: string): string => `${ESC}[1m${s}${ESC}[0m`;
const DIM = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;

export const codexRefactorFrames: TerminalFrame[] = [
  // 1. Resume command
  {
    atMs: 0,
    data: `${P}codex resume 88888888-8888-4888-a888-888888888888\r\n`,
  },

  // 2. Resume banner
  {
    atMs: 500,
    data: `${CYAN(BOLD('Codex CLI v0.9.3'))} ${DIM('resumed session 88888888')}\r\n\r\n`,
  },

  // 3. diff --stat
  {
    atMs: 1200,
    data: `${P}git diff --stat HEAD src/hooks/use-session-stream.ts\r\n`,
  },

  // 4. diff stat output
  {
    atMs: 1500,
    data:
      ` src/hooks/use-session-stream.ts | 16 ${GREEN('++++++++++++')}-${RED('----')}\r\n` +
      ` 1 file changed, ${GREEN('12 insertions(+)')}, ${RED('4 deletions(-)')}\r\n`,
  },

  // 4b. show the actual diff
  {
    atMs: 2000,
    data: `${P}git diff HEAD src/hooks/use-session-stream.ts | head -30\r\n`,
  },

  // 4c. diff chunk header
  {
    atMs: 2300,
    data: `${CYAN('@@ -21,12 +21,20 @@')} export function useSessionStream(sessionId: string) {\r\n`,
  },

  // 4d. diff removed lines
  {
    atMs: 2500,
    data:
      `${RED('-  const reconnect = () => {')} \r\n` +
      `${RED('-    const src = new EventSource(url)')}\r\n` +
      `${RED('-    eventSourceRef.current = src')}\r\n` +
      `${RED('-  }')}\r\n`,
  },

  // 4e. diff added lines
  {
    atMs: 2700,
    data:
      `${GREEN('+  const reconnect = useCallback(() => {')}\r\n` +
      `${GREEN("+    const from = lastEventIdRef.current ?? '0'")}\r\n` +
      `${GREEN('+    const src = new EventSource(`${url}?from=${from}`)')}\r\n` +
      `${GREEN('+    eventSourceRef.current = src')}\r\n` +
      `${GREEN('+  }, [sessionId, url])')}\r\n`,
  },

  // 5. run vitest
  {
    atMs: 3000,
    data: `${P}pnpm vitest run src/hooks\r\n`,
  },

  // 6a. vitest startup
  {
    atMs: 3500,
    data: `\r\n${BOLD(' RUN ')}  src/hooks\r\n\r\n`,
  },

  // 6b. first test
  {
    atMs: 4800,
    data: ` ${GREEN('✓')} use-session-stream > reconnects with lastEventId on error ${DIM('(51ms)')}\r\n`,
  },

  // 6c. second test
  {
    atMs: 6200,
    data: ` ${GREEN('✓')} use-session-stream > forwards events to session store ${DIM('(14ms)')}\r\n`,
  },

  // 6d. third test
  {
    atMs: 7900,
    data: ` ${GREEN('✓')} use-session-stream > cleans up EventSource on unmount ${DIM('(9ms)')}\r\n`,
  },

  // 6e. vitest summary
  {
    atMs: 9500,
    data:
      `\r\n` +
      ` ${BOLD(GREEN('Test Files'))}  ${GREEN('1 passed')} ${DIM('(1)')}\r\n` +
      `      ${BOLD(GREEN('Tests'))}  ${GREEN('3 passed')} ${DIM('(3)')}\r\n` +
      `   ${DIM('Duration')}  ${DIM('1.02s (transform 101ms, setup 13ms, tests 74ms)')}\r\n\r\n`,
  },

  // 7. typecheck
  {
    atMs: 11000,
    data: `${P}pnpm typecheck\r\n`,
  },

  // 8a. typecheck output
  {
    atMs: 11500,
    data: `${DIM('> tsc --noEmit')}\r\n`,
  },

  // 8b. typecheck dots (running)
  {
    atMs: 12500,
    data: DIM('.'),
  },

  {
    atMs: 13500,
    data: DIM('.'),
  },

  {
    atMs: 14500,
    data: DIM('.\r\n'),
  },

  // 8c. typecheck result
  {
    atMs: 15500,
    data: `${GREEN('No errors found.')} ${DIM('(exit 0)')}\r\n`,
  },

  // 9. git diff stat
  {
    atMs: 17000,
    data: `${P}git diff --stat\r\n`,
  },

  // 10. git diff output
  {
    atMs: 17200,
    data:
      ` src/hooks/use-session-stream.ts | 16 ${GREEN('++++++++++++')}-${RED('----')}\r\n` +
      ` 1 file changed, ${GREEN('12 insertions(+)')}, ${RED('4 deletions(-)')}\r\n`,
  },

  // 11. git add + commit
  {
    atMs: 19000,
    data: `${P}git add -A && git commit -m "refactor: use lastEventId for SSE catchup"\r\n`,
  },

  // 12a. commit staging
  {
    atMs: 19500,
    data: `${DIM('[main 3a7f21c]')} refactor: use lastEventId for SSE catchup\r\n`,
  },

  // 12b. commit stat
  {
    atMs: 19700,
    data:
      ` 1 file changed, ${GREEN('12 insertions(+)')}, ${RED('4 deletions(-)')}\r\n` +
      ` create mode 100644 src/hooks/use-session-stream.ts\r\n`,
  },

  // 13. summary banner
  {
    atMs: 22000,
    data:
      `\r\n` +
      `${BOLD(GREEN('Refactor complete.'))} 3 tests ${GREEN('green')}, typecheck ${GREEN('clean')}.\r\n` +
      `${DIM('Committed as 3a7f21c.')}\r\n\r\n`,
  },

  // 14. git log to confirm
  {
    atMs: 24000,
    data: `${P}git log --oneline -5\r\n`,
  },

  // 15. git log output
  {
    atMs: 24300,
    data:
      `${YELLOW('3a7f21c')} refactor: use lastEventId for SSE catchup\r\n` +
      `${DIM('b40f955')} fix(context-extractor): cap maxSummarizeTurns to bound LLM input\r\n` +
      `${DIM('a640df0')} feat(agent-switch): increase maxChars to 120k\r\n` +
      `${DIM('e52b828')} docs: add agent switch test results\r\n` +
      `${DIM('b2b8946')} refactor(agent-switch): use createAndEnqueueSession helper\r\n`,
  },

  // 16. run full test suite to confirm no regressions
  {
    atMs: 26000,
    data: `${P}pnpm vitest run --reporter=verbose 2>&1 | tail -6\r\n`,
  },

  // 17. test suite summary
  {
    atMs: 28000,
    data:
      `\r\n` +
      ` ${BOLD(GREEN('Test Files'))}  ${GREEN('12 passed')} ${DIM('(12)')}\r\n` +
      `      ${BOLD(GREEN('Tests'))}  ${GREEN('87 passed')} ${DIM('(87)')}\r\n` +
      `   ${DIM('Duration')}  ${DIM('4.3s')}\r\n\r\n`,
  },

  // 18. idle prompt
  {
    atMs: 35000,
    data: `\r\n`,
  },

  // 19. final prompt
  {
    atMs: 45000,
    data: `${P}`,
  },
];

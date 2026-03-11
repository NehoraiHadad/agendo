import { readClaudeSession } from './claude-reader';
import { readGeminiSession } from './gemini-reader';
import { readCodexSession } from './codex-reader';
import type { NativeReaderOptions, NativeReadResult } from './types';

export type {
  NativeTurn,
  NativeReadResult,
  NativeReaderOptions,
  NativeToolCall,
  NativeToolResult,
} from './types';

export async function readNativeSession(
  sessionRef: string,
  agentSlug: string,
  cwd: string,
  options?: NativeReaderOptions,
): Promise<NativeReadResult | null> {
  if (agentSlug.startsWith('claude')) {
    return readClaudeSession(sessionRef, cwd, options);
  }
  if (agentSlug.startsWith('gemini')) {
    return readGeminiSession(sessionRef, options);
  }
  if (agentSlug.startsWith('codex')) {
    return readCodexSession(sessionRef, options);
  }
  return null;
}

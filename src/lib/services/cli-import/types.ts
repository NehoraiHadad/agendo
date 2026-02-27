import type { AgendoEvent } from '@/lib/realtime/events';

export interface CliSessionEntry {
  cliSessionId: string;
  agentType: 'claude' | 'codex' | 'gemini';
  projectPath: string;
  summary: string | null;
  firstPrompt: string | null;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string | null;
  jsonlPath: string;
  alreadyImported: boolean;
}

export interface ConversionResult {
  events: AgendoEvent[];
  metadata: {
    model: string | null;
    totalTurns: number;
    sessionRef: string;
    firstPrompt: string | null;
  };
}

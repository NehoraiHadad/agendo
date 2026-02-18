import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ParsedOption {
  flags: string[];
  description: string;
  takesValue: boolean;
  valueHint: string | null;
}

export interface ParsedSubcommand {
  name: string;
  description: string;
  aliases: string[];
}

export interface ParsedSchema {
  options: ParsedOption[];
  subcommands: ParsedSubcommand[];
  source: 'help-regex' | 'unknown';
}

/**
 * Get help text from a tool. Uses execFile (no shell) for safety.
 * Tries --help then -h with 5s timeout.
 * Sets TERM=dumb and NO_COLOR=1 to prevent escape sequences.
 */
export async function getHelpText(toolName: string): Promise<string | null> {
  for (const args of [['--help'], ['-h']]) {
    try {
      const { stdout, stderr } = await execFileAsync(toolName, args, {
        timeout: 5000,
        maxBuffer: 1024 * 100,
        env: {
          ...process.env,
          TERM: 'dumb',
          NO_COLOR: '1',
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          // Unset nested-session guards so tools like claude/codex can run --help
          // even when launched from within an active agent session.
          CLAUDECODE: undefined,
          CLAUDE_SESSION_ID: undefined,
          CODEX_SESSION_ID: undefined,
        },
      });

      const output = stdout || stderr;
      if (output && output.length > 20) return output;
    } catch (err: unknown) {
      const execError = err as { stderr?: string; stdout?: string };
      const output = execError?.stderr || execError?.stdout;
      if (output && output.length > 20) return output;
      continue;
    }
  }
  return null;
}

/**
 * Fast regex-based help text parser.
 * Extracts options (--flags) and subcommands from --help output.
 */
export function quickParseHelp(helpText: string): ParsedSchema {
  const options: ParsedOption[] = [];
  const subcommands: ParsedSubcommand[] = [];

  // Extract options
  const optionRegex =
    /^\s+(--?[\w][\w-]*)(?:[,\s]+(--?[\w][\w-]*))?(?:\s+[<[]([\w.-]+)[>\]]|\s+([A-Z_]{2,}))?\s{2,}(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = optionRegex.exec(helpText)) !== null) {
    options.push({
      flags: [match[1], match[2]].filter((f): f is string => f !== null && f !== undefined),
      description: match[5].trim(),
      takesValue: (match[3] || match[4]) !== undefined,
      valueHint: match[3] || match[4] || null,
    });
  }

  // Extract subcommands
  const cmdRegex = /^\s{2,6}([\w][\w-]*)\s{2,}(.+)$/gm;
  while ((match = cmdRegex.exec(helpText)) !== null) {
    const name = match[1];
    const description = match[2].trim();

    if (name.startsWith('-')) continue;
    if (name.length < 2) continue;
    if (subcommands.some((sc) => sc.name === name)) continue;

    subcommands.push({ name, description, aliases: [] });
  }

  return {
    options,
    subcommands,
    source: options.length > 0 || subcommands.length > 0 ? 'help-regex' : 'unknown',
  };
}

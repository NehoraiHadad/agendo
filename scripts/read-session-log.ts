#!/usr/bin/env -S bun run
/**
 * Agendo Session Log Reader
 * Usage: bun scripts/read-session-log.ts <sessionId | /path/to/file.log>
 *
 * Reads an Agendo session log and prints each event in a clean, colored format.
 * Log lines are either:
 *   [stdout] {raw json}
 *   [system] [N|event:type] {agendo event json}
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgMagenta: '\x1b[45m',
};

const SESSIONS_BASE = '/data/agendo/logs/sessions';

function styled(color: string, text: string) {
  return `${color}${text}${C.reset}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return styled(C.gray, d.toISOString().replace('T', ' ').replace('Z', ''));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function findLogFile(sessionId: string): string | null {
  // Walk YYYY/MM directories looking for sessionId.log
  if (!existsSync(SESSIONS_BASE)) return null;
  for (const year of readdirSync(SESSIONS_BASE).sort().reverse()) {
    const yearPath = join(SESSIONS_BASE, year);
    if (!statSync(yearPath).isDirectory()) continue;
    for (const month of readdirSync(yearPath).sort().reverse()) {
      const candidate = join(yearPath, month, `${sessionId}.log`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ── Stdout event renderers ──────────────────────────────────────────────────

function renderStdoutSystem(data: any) {
  const tag = styled(C.bold + C.bgBlue + C.white, ' INIT ');
  const model = data.model ? ` model=${styled(C.cyan, data.model)}` : '';
  const cwd = data.cwd ? ` cwd=${styled(C.gray, data.cwd)}` : '';
  const mode = data.permissionMode ? ` mode=${styled(C.yellow, data.permissionMode)}` : '';
  const toolCount = data.tools?.length ? ` tools=${styled(C.gray, String(data.tools.length))}` : '';
  const sessionRef = data.session_id ? ` ref=${styled(C.gray, data.session_id)}` : '';
  console.log(`${tag}${model}${mode}${cwd}${toolCount}${sessionRef}`);
}

function renderStdoutAssistant(data: any) {
  const msg = data.message;
  if (!msg?.content) return;
  for (const block of msg.content) {
    if (block.type === 'thinking') {
      const tag = styled(C.dim + C.italic, '[thinking]');
      const text = styled(C.gray, truncate(block.thinking || '', 200));
      console.log(`  ${tag} ${text}`);
    } else if (block.type === 'text') {
      const tag = styled(C.bold + C.brightGreen, '[assistant]');
      // Print up to 5 lines of text
      const lines = block.text.split('\n').slice(0, 5);
      if (lines.length === 1) {
        console.log(`  ${tag} ${styled(C.white, truncate(lines[0], 160))}`);
      } else {
        console.log(`  ${tag}`);
        for (const line of lines) {
          console.log(`    ${styled(C.white, truncate(line, 160))}`);
        }
        if (block.text.split('\n').length > 5) {
          console.log(`    ${styled(C.gray, '…(truncated)')}`);
        }
      }
    } else if (block.type === 'tool_use') {
      const tag = styled(C.bold + C.cyan, '[tool_use]');
      const name = styled(C.brightCyan, block.name || '?');
      let input = '';
      if (block.input) {
        const keys = Object.keys(block.input).slice(0, 3);
        input = keys
          .map((k) => {
            const v = block.input[k];
            const vs = typeof v === 'string' ? truncate(v, 40) : JSON.stringify(v);
            return `${styled(C.gray, k)}=${styled(C.white, vs)}`;
          })
          .join(' ');
      }
      console.log(`  ${tag} ${name} ${input}`);
    } else if (block.type === 'tool_result') {
      const tag = styled(C.bold + C.yellow, '[tool_result]');
      const content = Array.isArray(block.content)
        ? block.content.map((c: any) => (c.type === 'text' ? c.text : c.type)).join(' ')
        : String(block.content ?? '');
      console.log(
        `  ${tag} id=${styled(C.gray, block.tool_use_id || '?')} ${styled(C.white, truncate(content, 120))}`,
      );
    }
  }
}

function renderStdoutResult(data: any) {
  const ok = !data.is_error;
  const tag = ok
    ? styled(C.bold + C.bgGreen + C.white, ' RESULT ')
    : styled(C.bold + C.bgRed + C.white, ' RESULT:ERROR ');
  const turns = `turns=${styled(C.brightYellow, String(data.num_turns ?? '?'))}`;
  const dur = data.duration_ms ? ` dur=${styled(C.cyan, `${data.duration_ms}ms`)}` : '';
  const cost =
    data.total_cost_usd != null
      ? ` cost=${styled(C.brightMagenta, `$${data.total_cost_usd.toFixed(4)}`)}`
      : '';
  const preview = data.result
    ? `\n  ${styled(C.white, truncate(data.result.replace(/\n/g, ' '), 160))}`
    : '';
  console.log(`${tag} ${turns}${dur}${cost}${preview}`);
}

// ── System event renderers ──────────────────────────────────────────────────

function renderSystemEvent(eventNum: number, eventType: string, data: any) {
  const ts = data.ts ? formatTimestamp(data.ts) : '';

  switch (eventType) {
    case 'session:init': {
      const tag = styled(C.bold + C.bgBlue + C.white, ' SESSION:INIT ');
      const mcpOk = (data.mcpServers || [])
        .filter((s: any) => s.status === 'connected')
        .map((s: any) => styled(C.green, s.name.replace(/^plugin:\w+:/, '')))
        .join(', ');
      const mcpFail = (data.mcpServers || [])
        .filter((s: any) => s.status === 'failed')
        .map((s: any) => styled(C.red, s.name.replace(/^plugin:\w+:/, '')))
        .join(', ');
      console.log(`${ts} ${tag}`);
      if (mcpOk) console.log(`  ${styled(C.gray, 'MCP ok:')} ${mcpOk}`);
      if (mcpFail) console.log(`  ${styled(C.gray, 'MCP fail:')} ${mcpFail}`);
      break;
    }

    case 'session:state': {
      const status = data.status || '?';
      const color =
        status === 'awaiting_input'
          ? C.brightGreen
          : status === 'idle'
            ? C.gray
            : status === 'running'
              ? C.yellow
              : C.white;
      const tag = styled(C.bold, '[session:state]');
      console.log(`${ts} ${tag} ${styled(color + C.bold, status)}`);
      break;
    }

    case 'agent:activity': {
      const thinking = data.thinking;
      const tag = styled(C.bold + C.magenta, '[agent:activity]');
      const state = thinking ? styled(C.brightYellow, 'thinking…') : styled(C.green, 'done');
      console.log(`${ts} ${tag} ${state}`);
      break;
    }

    case 'agent:thinking': {
      const tag = styled(C.dim + C.italic, '[agent:thinking]');
      const text = styled(C.gray, truncate(data.text || '', 200));
      console.log(`${ts} ${tag} ${text}`);
      break;
    }

    case 'agent:text': {
      const tag = styled(C.bold + C.brightGreen, '[agent:text]');
      const lines = (data.text || '').split('\n').slice(0, 4);
      console.log(`${ts} ${tag} ${styled(C.white, truncate(lines[0] || '', 160))}`);
      for (const line of lines.slice(1)) {
        console.log(`    ${styled(C.white, truncate(line, 160))}`);
      }
      if ((data.text || '').split('\n').length > 4) {
        console.log(`    ${styled(C.gray, '…(truncated)')}`);
      }
      break;
    }

    case 'agent:result': {
      const tag = styled(C.bold + C.bgGreen + C.white, ' AGENT:RESULT ');
      const turns = `turns=${styled(C.brightYellow, String(data.turns ?? '?'))}`;
      const dur = data.durationMs ? ` dur=${styled(C.cyan, `${data.durationMs}ms`)}` : '';
      const cost =
        data.costUsd != null
          ? ` cost=${styled(C.brightMagenta, `$${data.costUsd.toFixed(4)}`)}`
          : '';
      console.log(`${ts} ${tag} ${turns}${dur}${cost}`);
      break;
    }

    case 'agent:tool-start': {
      const tag = styled(C.dim + C.cyan, '[tool→]');
      const id = data.toolUseId ? styled(C.gray, data.toolUseId.slice(-8)) : '';
      console.log(`${ts} ${tag} ${id}`);
      break;
    }

    case 'agent:tool-end': {
      const tag = styled(C.dim + C.cyan, '[←tool]');
      const id = data.toolUseId ? styled(C.gray, data.toolUseId.slice(-8)) : '';
      const dur = data.durationMs ? ` ${styled(C.gray, `${data.durationMs}ms`)}` : '';
      console.log(`${ts} ${tag} ${id}${dur}`);
      break;
    }

    case 'system:info': {
      const tag = styled(C.bold + C.bgYellow + C.white, ' SYSTEM:INFO ');
      console.log(`${ts} ${tag} ${styled(C.yellow, data.message || '')}`);
      break;
    }

    default: {
      // Generic fallback for unknown event types
      const tag = styled(C.gray, `[${eventType}]`);
      const preview = truncate(JSON.stringify(data), 120);
      console.log(`${ts} ${tag} ${styled(C.gray, preview)}`);
      break;
    }
  }
}

// ── Line parser ─────────────────────────────────────────────────────────────

function parseLine(line: string, lineNum: number) {
  if (line.startsWith('[stdout] ')) {
    const jsonStr = line.slice('[stdout] '.length);
    let data: any;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      console.log(
        styled(C.red, `[line ${lineNum}] [stdout] invalid JSON: ${truncate(jsonStr, 80)}`),
      );
      return;
    }

    switch (data.type) {
      case 'system':
        renderStdoutSystem(data);
        break;
      case 'assistant':
        renderStdoutAssistant(data);
        break;
      case 'result':
        renderStdoutResult(data);
        break;
      case 'user':
        // User messages: just show first text content
        {
          const content = data.message?.content;
          const texts = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text)
            : typeof content === 'string'
              ? [content]
              : [];
          if (texts.length) {
            const tag = styled(C.bold + C.brightBlue, '[user]');
            for (const t of texts) {
              const first = t.split('\n')[0];
              console.log(`  ${tag} ${styled(C.white, truncate(first, 160))}`);
            }
          }
        }
        break;
      case 'tool_use':
      case 'tool_result':
        // handled inside assistant blocks; skip top-level
        break;
      default:
        // unknown stdout type
        console.log(
          styled(C.gray, `  [stdout:${data.type}] ${truncate(JSON.stringify(data), 100)}`),
        );
    }
    return;
  }

  if (line.startsWith('[system] ')) {
    // [system] [N|event:type] {json}
    const rest = line.slice('[system] '.length);
    const headerMatch = rest.match(/^\[(\d+)\|([^\]]+)\]\s*(.*)/s);
    if (!headerMatch) {
      console.log(styled(C.red, `[line ${lineNum}] malformed system line: ${truncate(rest, 80)}`));
      return;
    }
    const [, numStr, eventType, jsonStr] = headerMatch;
    const eventNum = parseInt(numStr, 10);
    let data: any = {};
    if (jsonStr.trim()) {
      try {
        data = JSON.parse(jsonStr);
      } catch {
        console.log(
          styled(
            C.red,
            `[line ${lineNum}] [system:${eventType}] invalid JSON: ${truncate(jsonStr, 80)}`,
          ),
        );
        return;
      }
    }
    renderSystemEvent(eventNum, eventType, data);
    return;
  }

  // Unknown line format
  if (line.trim()) {
    console.log(styled(C.gray, `[line ${lineNum}] ${truncate(line, 120)}`));
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(`Usage: bun scripts/read-session-log.ts <sessionId | /path/to/file.log>`);
    process.exit(1);
  }

  let logPath: string;

  // If it looks like a file path, use it directly
  if (arg.startsWith('/') || arg.startsWith('./') || arg.endsWith('.log')) {
    logPath = arg;
  } else {
    // Treat as session ID, search for it
    const found = findLogFile(arg);
    if (!found) {
      console.error(`Session log not found for ID: ${arg}\nSearched in: ${SESSIONS_BASE}`);
      process.exit(1);
    }
    logPath = found;
  }

  if (!existsSync(logPath)) {
    console.error(`File not found: ${logPath}`);
    process.exit(1);
  }

  console.log(styled(C.bold + C.brightWhite, `\n=== Agendo Session Log ===`));
  console.log(styled(C.gray, `File: ${logPath}`));
  console.log(styled(C.gray, '─'.repeat(80)) + '\n');

  const rl = createInterface({
    input: createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    parseLine(line, lineNum);
  }

  console.log('\n' + styled(C.gray, '─'.repeat(80)));
  console.log(styled(C.dim, `Total lines: ${lineNum}`));
}

main().catch((err) => {
  console.error(styled(C.red, `Fatal error: ${err.message}`));
  process.exit(1);
});

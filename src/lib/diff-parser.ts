import { diffLines } from 'diff';

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export function parseEditDiff(oldStr: string, newStr: string): ParsedDiff {
  const changes = diffLines(oldStr, newStr);
  const allLines: DiffLine[] = [];

  for (const change of changes) {
    const rawLines = change.value.split('\n');
    // diffLines includes a trailing empty string if the value ends with \n
    const lines =
      rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
    const type: DiffLine['type'] = change.added
      ? 'added'
      : change.removed
        ? 'removed'
        : 'unchanged';
    for (const line of lines) {
      allLines.push({ type, content: line });
    }
  }

  // Group consecutive lines of the same type into hunks
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;

  for (const line of allLines) {
    if (!currentHunk || currentHunk.lines[0]?.type !== line.type) {
      currentHunk = { lines: [line] };
      hunks.push(currentHunk);
    } else {
      currentHunk.lines.push(line);
    }
  }

  const additions = allLines.filter((l) => l.type === 'added').length;
  const deletions = allLines.filter((l) => l.type === 'removed').length;

  return { hunks, additions, deletions };
}

export function parseWriteContent(
  content: string,
  filePath?: string,
): { language: string; content: string } {
  const ext = filePath?.split('.').pop()?.toLowerCase() ?? 'txt';
  const knownExts = new Set([
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'rs',
    'go',
    'java',
    'rb',
    'sh',
    'bash',
    'json',
    'yaml',
    'yml',
    'toml',
    'md',
    'css',
    'html',
    'xml',
    'sql',
    'txt',
  ]);
  const language = knownExts.has(ext) ? ext : 'txt';
  return { language, content };
}

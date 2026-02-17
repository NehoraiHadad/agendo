import AnsiToHtml from 'ansi-to-html';
import DOMPurify from 'isomorphic-dompurify';

const ansiConverter = new AnsiToHtml({
  escapeXML: true,
  newline: false,
});

const ALLOWED_TAGS = ['span'];
const ALLOWED_ATTR = ['style'];

export type StreamType = 'stdout' | 'stderr' | 'system' | 'user';

const STREAM_COLOR_CLASSES: Record<StreamType, string> = {
  stdout: 'text-zinc-100',
  stderr: 'text-amber-400',
  system: 'text-blue-400',
  user: 'text-green-400',
};

export function getStreamColorClass(stream: StreamType): string {
  return STREAM_COLOR_CLASSES[stream];
}

export interface RenderedLine {
  id: number;
  html: string;
  text: string;
  stream: StreamType;
}

let lineIdCounter = 0;

export function resetLineIdCounter(): void {
  lineIdCounter = 0;
}

export function renderLogLine(raw: string, stream: StreamType): RenderedLine {
  const html = DOMPurify.sanitize(ansiConverter.toHtml(raw), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
  // Strip HTML tags for plain text (used in search)
  // eslint-disable-next-line no-control-regex -- intentionally stripping ANSI escape sequences
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
  return {
    id: ++lineIdCounter,
    html,
    text,
    stream,
  };
}

export function renderLogChunk(content: string, stream: StreamType): RenderedLine[] {
  const lines = content.split('\n');
  // Remove trailing empty line from split
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line) => renderLogLine(line, stream));
}

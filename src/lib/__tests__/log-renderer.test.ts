import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderLogLine,
  renderLogChunk,
  getStreamColorClass,
  resetLineIdCounter,
} from '../log-renderer';

describe('log-renderer', () => {
  beforeEach(() => {
    resetLineIdCounter();
  });

  describe('getStreamColorClass', () => {
    it('returns text-zinc-100 for stdout', () => {
      expect(getStreamColorClass('stdout')).toBe('text-zinc-100');
    });

    it('returns text-amber-400 for stderr', () => {
      expect(getStreamColorClass('stderr')).toBe('text-amber-400');
    });

    it('returns text-blue-400 for system', () => {
      expect(getStreamColorClass('system')).toBe('text-blue-400');
    });

    it('returns text-green-400 for user', () => {
      expect(getStreamColorClass('user')).toBe('text-green-400');
    });
  });

  describe('resetLineIdCounter', () => {
    it('resets the monotonic counter so IDs start at 1 again', () => {
      const first = renderLogLine('line one', 'stdout');
      const second = renderLogLine('line two', 'stdout');
      expect(first.id).toBe(1);
      expect(second.id).toBe(2);

      resetLineIdCounter();

      const afterReset = renderLogLine('line after reset', 'stdout');
      expect(afterReset.id).toBe(1);
    });
  });

  describe('renderLogLine — line IDs are monotonically increasing', () => {
    it('assigns sequential IDs across multiple calls', () => {
      const a = renderLogLine('a', 'stdout');
      const b = renderLogLine('b', 'stdout');
      const c = renderLogLine('c', 'stderr');

      expect(a.id).toBe(1);
      expect(b.id).toBe(2);
      expect(c.id).toBe(3);
      expect(b.id).toBeGreaterThan(a.id);
      expect(c.id).toBeGreaterThan(b.id);
    });
  });

  describe('renderLogLine — ANSI codes converted to HTML', () => {
    it('converts bold ANSI escape: text is preserved (bold tag is stripped by DOMPurify)', () => {
      // \x1b[1m is "bold" — ansi-to-html renders it as <b>hello</b>,
      // but DOMPurify only allows <span>, so <b> is stripped and text remains.
      const result = renderLogLine('\x1b[1mhello\x1b[0m', 'stdout');
      expect(result.html).toContain('hello');
    });

    it('converts color ANSI escape to <span style="color:..."> ', () => {
      // \x1b[32m is green foreground — ansi-to-html renders as <span style="color:...">
      const result = renderLogLine('\x1b[32mgreen text\x1b[0m', 'stdout');
      expect(result.html).toContain('green text');
      expect(result.html).toContain('style=');
      expect(result.html).toContain('<span');
    });

    it('sets stream correctly on the returned object', () => {
      const result = renderLogLine('msg', 'stderr');
      expect(result.stream).toBe('stderr');
    });
  });

  describe('renderLogLine — XSS prevention', () => {
    it('prevents execution of <script> payloads in raw input', () => {
      // ansi-to-html's escapeXML:true encodes angle brackets to entities first,
      // so <script> never reaches the DOM as a real tag.
      const result = renderLogLine('<script>alert("xss")</script>', 'stdout');
      // Must not contain an executable <script> tag
      expect(result.html).not.toContain('<script>');
      expect(result.html).not.toContain('</script>');
    });

    it('prevents execution of event-handler attributes in raw input', () => {
      // ansi-to-html's escapeXML:true encodes < and > to &lt;/&gt; before DOMPurify sees it.
      // The result is inert entity-encoded text — no live HTML element is produced.
      // We verify the output does NOT contain a real opening HTML tag with onclick.
      const result = renderLogLine('<div onclick="evil()">click</div>', 'stdout');
      // A real (unescaped) HTML tag with onclick would look like: <div onclick=...>
      // The entity-encoded form &lt;div onclick...&gt; is safe inert text.
      expect(result.html).not.toMatch(/<[a-z]+ [^>]*onclick/i);
    });

    it('prevents execution of onerror payloads on <img> tags', () => {
      const result = renderLogLine('<img src=x onerror="evil()">', 'stdout');
      // No real executable <img> tag must remain
      expect(result.html).not.toContain('<img');
    });

    it('does not produce executable anchor tags in the output', () => {
      const result = renderLogLine('<a href="http://evil.com">link</a>', 'stdout');
      // Anchor tag must not be present as a real HTML element
      expect(result.html).not.toMatch(/<a\s/);
    });

    it('returns a string for plain text input (no dangerous content)', () => {
      const result = renderLogLine('Hello, world!', 'stdout');
      expect(result.html).toBe('Hello, world!');
    });
  });

  describe('renderLogLine — plain text for search', () => {
    it('strips ANSI escape codes from text field', () => {
      const result = renderLogLine('\x1b[32mhello\x1b[0m world', 'stdout');
      expect(result.text).toBe('hello world');
      expect(result.text).not.toContain('\x1b');
    });

    it('returns plain text unchanged when no ANSI codes present', () => {
      const result = renderLogLine('plain text line', 'stdout');
      expect(result.text).toBe('plain text line');
    });

    it('strips only ANSI SGR codes (color/style), not arbitrary escape sequences', () => {
      // ANSI color code followed by normal text
      const result = renderLogLine('\x1b[31mred\x1b[0m normal', 'stdout');
      expect(result.text).toBe('red normal');
    });
  });

  describe('renderLogChunk', () => {
    it('splits content into lines on newline character', () => {
      const result = renderLogChunk('line1\nline2\nline3', 'stdout');
      expect(result).toHaveLength(3);
      expect(result[0].text).toBe('line1');
      expect(result[1].text).toBe('line2');
      expect(result[2].text).toBe('line3');
    });

    it('handles trailing newline by not producing an empty trailing line', () => {
      const result = renderLogChunk('line1\nline2\n', 'stdout');
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('line1');
      expect(result[1].text).toBe('line2');
    });

    it('returns a single-element array for content with no newline', () => {
      const result = renderLogChunk('single line', 'stdout');
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('single line');
    });

    it('returns an empty array for an empty string', () => {
      const result = renderLogChunk('', 'stdout');
      expect(result).toHaveLength(0);
    });

    it('assigns correct stream type to every produced line', () => {
      const result = renderLogChunk('a\nb', 'stderr');
      expect(result[0].stream).toBe('stderr');
      expect(result[1].stream).toBe('stderr');
    });

    it('assigns monotonically increasing IDs across all lines', () => {
      const result = renderLogChunk('x\ny\nz', 'stdout');
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
      expect(result[2].id).toBe(3);
    });

    it('parses [stream] prefixes and overrides the default stream', () => {
      const content = '[system] Execution started\n[stdout] {"type":"assistant"}\n[stderr] error msg';
      const result = renderLogChunk(content, 'stdout');
      expect(result).toHaveLength(3);
      expect(result[0].stream).toBe('system');
      expect(result[0].text).toBe('Execution started');
      expect(result[1].stream).toBe('stdout');
      expect(result[1].text).toBe('{"type":"assistant"}');
      expect(result[2].stream).toBe('stderr');
      expect(result[2].text).toBe('error msg');
    });

    it('falls back to defaultStream for lines without a known prefix', () => {
      const result = renderLogChunk('plain line\n[other] not a prefix', 'stderr');
      expect(result[0].stream).toBe('stderr');
      expect(result[1].stream).toBe('stderr');
    });

    it('skips empty lines in the chunk', () => {
      const result = renderLogChunk('[stdout] a\n\n[stdout] b', 'stdout');
      expect(result).toHaveLength(2);
    });
  });
});

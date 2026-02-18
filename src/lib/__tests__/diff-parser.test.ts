import { describe, it, expect } from 'vitest';
import { parseEditDiff, parseWriteContent } from '@/lib/diff-parser';

describe('parseEditDiff', () => {
  it('produces additions and deletions counts', () => {
    const result = parseEditDiff('hello\nworld\n', 'hello\nearth\n');
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
  });

  it('produces hunks with correct types', () => {
    const result = parseEditDiff('a\nb\nc\n', 'a\nB\nc\n');
    const allLines = result.hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === 'added')).toBe(true);
    expect(allLines.some((l) => l.type === 'removed')).toBe(true);
    expect(allLines.some((l) => l.type === 'unchanged')).toBe(true);
  });

  it('handles empty old string (pure add)', () => {
    const result = parseEditDiff('', 'new content\n');
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBe(0);
  });
});

describe('parseWriteContent', () => {
  it('returns content and language', () => {
    const result = parseWriteContent('const x = 1;\n', 'foo.ts');
    expect(result.content).toBe('const x = 1;\n');
    expect(result.language).toBe('ts');
  });

  it('returns txt for unknown extension', () => {
    const result = parseWriteContent('hello', 'README');
    expect(result.language).toBe('txt');
  });
});

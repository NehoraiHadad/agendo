import { describe, it, expect } from 'vitest';
import { scanPATH, type ScannedBinary } from '../scanner';

describe('scanPATH', () => {
  it('returns a Map with size > 0', async () => {
    const result = await scanPATH();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBeGreaterThan(0);
  });

  it('deduplicates binary names (each name appears only once)', async () => {
    const result = await scanPATH();
    const names = Array.from(result.keys());
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('populates symlink fields (isSymlink and realPath) on every entry', async () => {
    const result = await scanPATH();
    for (const [, entry] of result) {
      expect(typeof entry.isSymlink).toBe('boolean');
      expect(typeof entry.realPath).toBe('string');
      expect(entry.realPath.length).toBeGreaterThan(0);
    }
  });

  it('each ScannedBinary has name, path, realPath, isSymlink, dir fields', async () => {
    const result = await scanPATH();
    expect(result.size).toBeGreaterThan(0);

    const first = result.values().next().value as ScannedBinary;
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('realPath');
    expect(first).toHaveProperty('isSymlink');
    expect(first).toHaveProperty('dir');

    expect(typeof first.name).toBe('string');
    expect(typeof first.path).toBe('string');
    expect(typeof first.realPath).toBe('string');
    expect(typeof first.isSymlink).toBe('boolean');
    expect(typeof first.dir).toBe('string');
  });
});

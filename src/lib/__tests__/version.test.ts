import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, isNewerVersion } from '../version';

describe('version utilities', () => {
  describe('parseVersion', () => {
    it('parses a standard semver string', () => {
      expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it('parses version with v prefix', () => {
      expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it('parses 0.1.0', () => {
      expect(parseVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0 });
    });

    it('returns null for invalid version strings', () => {
      expect(parseVersion('invalid')).toBeNull();
      expect(parseVersion('')).toBeNull();
      expect(parseVersion('1.2')).toBeNull();
      expect(parseVersion('abc.def.ghi')).toBeNull();
    });

    it('handles large version numbers', () => {
      expect(parseVersion('10.200.3000')).toEqual({
        major: 10,
        minor: 200,
        patch: 3000,
      });
    });
  });

  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    });

    it('returns 1 when a > b (major)', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    });

    it('returns -1 when a < b (major)', () => {
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    });

    it('compares minor versions', () => {
      expect(compareVersions('1.2.0', '1.1.0')).toBe(1);
      expect(compareVersions('1.1.0', '1.2.0')).toBe(-1);
    });

    it('compares patch versions', () => {
      expect(compareVersions('1.0.2', '1.0.1')).toBe(1);
      expect(compareVersions('1.0.1', '1.0.2')).toBe(-1);
    });

    it('handles v prefix', () => {
      expect(compareVersions('v1.0.1', '1.0.0')).toBe(1);
    });

    it('returns 0 for invalid versions', () => {
      expect(compareVersions('invalid', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', 'invalid')).toBe(0);
    });
  });

  describe('isNewerVersion', () => {
    it('returns true when available > current', () => {
      expect(isNewerVersion('1.1.0', '1.0.0')).toBe(true);
    });

    it('returns false when available == current', () => {
      expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    });

    it('returns false when available < current', () => {
      expect(isNewerVersion('1.0.0', '1.1.0')).toBe(false);
    });

    it('returns false for invalid input', () => {
      expect(isNewerVersion('invalid', '1.0.0')).toBe(false);
    });

    it('handles v prefix on available', () => {
      expect(isNewerVersion('v2.0.0', '1.0.0')).toBe(true);
    });
  });
});

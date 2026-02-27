import { describe, it, expect } from 'vitest';
import { decodeDirName } from '../decode-dir';

describe('decodeDirName', () => {
  it('converts leading dash to slash and hyphens to slashes', () => {
    expect(decodeDirName('-home-ubuntu-projects-agendo')).toBe('/home/ubuntu/projects/agendo');
  });

  it('handles root-level paths', () => {
    expect(decodeDirName('-tmp')).toBe('/tmp');
  });

  it('handles deeply nested paths', () => {
    expect(decodeDirName('-home-ubuntu-projects-story-creator')).toBe(
      '/home/ubuntu/projects/story/creator',
    );
  });

  it('handles single component', () => {
    expect(decodeDirName('-mnt')).toBe('/mnt');
  });
});

import { describe, it, expect } from 'vitest';
import { parseChangelog } from '../changelog-parser';

const SAMPLE_CHANGELOG = `# Changelog

## [0.3.0] - 2026-03-20

### Features

- amazing new feature (abc1234)
- another feature (def5678)

### Fixed

- critical bug fix (aaa1111)

## [0.2.0] - 2026-03-18

### Features

- brainstorm replay from participant getHistory() (c826b24)
- version management (383c400)

### Refactoring

- compact wave status header (82c3f4a)

## [0.1.0] - 2026-03-10

### Features

- initial release (000aaa0)
- kanban board (111bbb1)

### Fixed

- startup crash (222ccc2)

## [0.0.1] - 2026-03-01

### Features

- prototype (333ddd3)
`;

describe('changelog-parser', () => {
  it('parses all versions from changelog markdown', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);

    expect(entries).toHaveLength(4);
    expect(entries[0].version).toBe('0.3.0');
    expect(entries[1].version).toBe('0.2.0');
    expect(entries[2].version).toBe('0.1.0');
    expect(entries[3].version).toBe('0.0.1');
  });

  it('extracts dates correctly', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);

    expect(entries[0].date).toBe('2026-03-20');
    expect(entries[1].date).toBe('2026-03-18');
  });

  it('extracts sections with their items', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    const v030 = entries[0];

    expect(v030.sections).toHaveLength(2);
    expect(v030.sections[0].title).toBe('Features');
    expect(v030.sections[0].items).toEqual([
      'amazing new feature (abc1234)',
      'another feature (def5678)',
    ]);
    expect(v030.sections[1].title).toBe('Fixed');
    expect(v030.sections[1].items).toEqual(['critical bug fix (aaa1111)']);
  });

  it('returns limited entries when count is specified', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG, { limit: 2 });

    expect(entries).toHaveLength(2);
    expect(entries[0].version).toBe('0.3.0');
    expect(entries[1].version).toBe('0.2.0');
  });

  it('returns empty array for empty input', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n')).toEqual([]);
  });

  it('handles changelog with single version', () => {
    const single = `# Changelog

## [1.0.0] - 2026-01-01

### Added

- first stable release (abc1234)
`;
    const entries = parseChangelog(single);

    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('1.0.0');
    expect(entries[0].sections[0].items).toEqual(['first stable release (abc1234)']);
  });

  it('handles entries without sections gracefully', () => {
    const noSections = `# Changelog

## [1.0.0] - 2026-01-01

## [0.9.0] - 2025-12-01

### Features

- some feature (abc1234)
`;
    const entries = parseChangelog(noSections);

    expect(entries).toHaveLength(2);
    expect(entries[0].sections).toEqual([]);
    expect(entries[1].sections).toHaveLength(1);
  });

  it('preserves section order', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    const v020 = entries[1];

    expect(v020.sections.map((s) => s.title)).toEqual(['Features', 'Refactoring']);
  });
});

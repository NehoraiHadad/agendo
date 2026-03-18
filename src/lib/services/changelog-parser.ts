/**
 * Parses CHANGELOG.md into structured entries.
 *
 * Expected format (Keep a Changelog / release.sh output):
 *   ## [0.2.0] - 2026-03-18
 *   ### Features
 *   - some feature description (commit-hash)
 */

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

export interface ParseOptions {
  /** Maximum number of entries to return (default: all). */
  limit?: number;
}

const VERSION_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/;
const SECTION_HEADING_RE = /^### (.+)/;
const LIST_ITEM_RE = /^- (.+)/;

/**
 * Parse a CHANGELOG.md string into structured entries.
 * Returns entries in document order (newest first, assuming standard changelog layout).
 */
export function parseChangelog(content: string, opts?: ParseOptions): ChangelogEntry[] {
  const lines = content.split('\n');
  const entries: ChangelogEntry[] = [];
  let currentEntry: ChangelogEntry | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const line of lines) {
    const versionMatch = VERSION_HEADING_RE.exec(line);
    if (versionMatch) {
      // Finalize previous section/entry
      if (currentSection && currentEntry) {
        currentEntry.sections.push(currentSection);
        currentSection = null;
      }
      if (currentEntry) {
        entries.push(currentEntry);
      }

      // Check limit
      if (opts?.limit && entries.length >= opts.limit) {
        break;
      }

      currentEntry = {
        version: versionMatch[1],
        date: versionMatch[2],
        sections: [],
      };
      continue;
    }

    const sectionMatch = SECTION_HEADING_RE.exec(line);
    if (sectionMatch && currentEntry) {
      if (currentSection) {
        currentEntry.sections.push(currentSection);
      }
      currentSection = {
        title: sectionMatch[1],
        items: [],
      };
      continue;
    }

    const itemMatch = LIST_ITEM_RE.exec(line);
    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1]);
    }
  }

  // Finalize last section/entry
  if (currentSection && currentEntry) {
    currentEntry.sections.push(currentSection);
  }
  if (currentEntry && (!opts?.limit || entries.length < opts.limit)) {
    entries.push(currentEntry);
  }

  return entries;
}

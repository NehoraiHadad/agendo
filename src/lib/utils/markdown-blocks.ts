/**
 * Splits raw markdown content into logical block units suitable for
 * per-block annotation selection.
 *
 * Design constraints
 * ------------------
 * - Every public block has a stable `id` of the form `block-{lineStart}` (1-indexed).
 * - Blank-only lines are skipped; they do not produce blocks.
 * - The parser is intentionally simple — it does not need to be a full
 *   CommonMark implementation, just good enough to identify coherent visual
 *   regions in a plan document.
 */

export type BlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'paragraph'
  | 'list'
  | 'codeblock'
  | 'blockquote'
  | 'hr'
  | 'table';

export interface MarkdownBlock {
  /** Stable unique id: `block-{lineStart}`. */
  id: string;
  type: BlockType;
  /** Raw markdown content (used for rendering + selectedText). */
  raw: string;
  /** 1-indexed. */
  lineStart: number;
  /** 1-indexed, inclusive. */
  lineEnd: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the heading level if the line is a heading, or 0 otherwise. */
function headingLevel(line: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const m = /^(#{1,6})\s/.exec(line);
  if (!m) return 0;
  return m[1].length as 1 | 2 | 3 | 4 | 5 | 6;
}

function isHrLine(line: string): boolean {
  return /^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim());
}

function isFenceDelimiter(line: string): boolean {
  return /^(`{3,}|~{3,})/.test(line);
}

/** Returns the fence character sequence that opened the block (e.g. "```" or "~~~"). */
function fenceToken(line: string): string {
  const m = /^(`{3,}|~{3,})/.exec(line);
  return m ? m[1] : '';
}

function isBlockquoteLine(line: string): boolean {
  return /^>\s?/.test(line);
}

function isListLine(line: string): boolean {
  // Unordered: "- ", "* ", "+ "  (possibly indented)
  // Ordered: "1. ", "12. "  (possibly indented)
  return /^\s*([-*+]|\d+\.)\s/.test(line);
}

function isTableLine(line: string): boolean {
  return /\|/.test(line);
}

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

function makeBlock(type: BlockType, rawLines: string[], lineStart: number): MarkdownBlock {
  return {
    id: `block-${lineStart}`,
    type,
    raw: rawLines.join('\n'),
    lineStart,
    lineEnd: lineStart + rawLines.length - 1,
  };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Splits `content` into an ordered array of `MarkdownBlock`s.
 *
 * Parsing strategy (greedy, single-pass):
 * 1. Skip blank lines.
 * 2. If a fenced code block delimiter is encountered, consume until the
 *    matching closing fence (or EOF).
 * 3. Horizontal rules (--- / *** / ___) are single-line blocks.
 * 4. ATX headings (# … ######) are single-line blocks.
 * 5. Blockquote lines (>) are accumulated until a non-blockquote, non-blank line.
 * 6. List items are accumulated across blank lines as long as the next
 *    non-blank line is still a list item (preserving multi-paragraph list items).
 * 7. Table lines (containing |) are accumulated into a table block.
 * 8. Everything else becomes a paragraph, accumulated until a blank line or
 *    a structural boundary.
 */
export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0; // 0-based index into `lines`

  while (i < lines.length) {
    const line = lines[i];

    // ── Skip blank lines ──────────────────────────────────────────────────
    if (isBlankLine(line)) {
      i++;
      continue;
    }

    const lineStart1 = i + 1; // convert to 1-indexed for block metadata

    // ── Fenced code block ─────────────────────────────────────────────────
    if (isFenceDelimiter(line)) {
      const openToken = fenceToken(line);
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        rawLines.push(cur);
        i++;
        // Closing fence: same or longer sequence of the same character
        if (cur.trimStart().startsWith(openToken)) {
          break;
        }
      }
      blocks.push(makeBlock('codeblock', rawLines, lineStart1));
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (isHrLine(line)) {
      blocks.push(makeBlock('hr', [line], lineStart1));
      i++;
      continue;
    }

    // ── ATX Heading ───────────────────────────────────────────────────────
    const hl = headingLevel(line);
    if (hl > 0) {
      const type = `h${hl}` as BlockType;
      blocks.push(makeBlock(type, [line], lineStart1));
      i++;
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (isBlockquoteLine(line)) {
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (isBlankLine(cur)) {
          // Peek ahead: if the next non-blank line is also a blockquote, continue.
          let j = i + 1;
          while (j < lines.length && isBlankLine(lines[j])) j++;
          if (j < lines.length && isBlockquoteLine(lines[j])) {
            // Consume the blank lines too, to keep the block contiguous.
            while (i < j) {
              rawLines.push(lines[i]);
              i++;
            }
            continue;
          }
          break;
        }
        if (!isBlockquoteLine(cur)) break;
        rawLines.push(cur);
        i++;
      }
      blocks.push(makeBlock('blockquote', rawLines, lineStart1));
      continue;
    }

    // ── List ──────────────────────────────────────────────────────────────
    if (isListLine(line)) {
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (isBlankLine(cur)) {
          // Peek ahead: if the next non-blank line is a list item, keep the
          // blank line as part of this block (multi-paragraph list item).
          let j = i + 1;
          while (j < lines.length && isBlankLine(lines[j])) j++;
          if (j < lines.length && isListLine(lines[j])) {
            // Include the blank separator line(s) in the block.
            while (i < j) {
              rawLines.push(lines[i]);
              i++;
            }
            continue;
          }
          break;
        }
        // Continuation lines (indented or non-blank non-structure) also belong
        // to the current list item or block, unless they start a new structure.
        if (
          headingLevel(cur) > 0 ||
          isHrLine(cur) ||
          isFenceDelimiter(cur) ||
          isBlockquoteLine(cur) ||
          isTableLine(cur)
        ) {
          break;
        }
        rawLines.push(cur);
        i++;
      }
      blocks.push(makeBlock('list', rawLines, lineStart1));
      continue;
    }

    // ── Table ─────────────────────────────────────────────────────────────
    if (isTableLine(line)) {
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (isBlankLine(cur) || !isTableLine(cur)) break;
        rawLines.push(cur);
        i++;
      }
      blocks.push(makeBlock('table', rawLines, lineStart1));
      continue;
    }

    // ── Paragraph (catch-all) ─────────────────────────────────────────────
    {
      const rawLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (isBlankLine(cur)) break;
        // Stop at any structural boundary.
        if (
          headingLevel(cur) > 0 ||
          isHrLine(cur) ||
          isFenceDelimiter(cur) ||
          isBlockquoteLine(cur) ||
          isListLine(cur) ||
          isTableLine(cur)
        ) {
          break;
        }
        rawLines.push(cur);
        i++;
      }
      blocks.push(makeBlock('paragraph', rawLines, lineStart1));
    }
  }

  return blocks;
}

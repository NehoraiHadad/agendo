/**
 * Demo-coverage meta-test.
 *
 * Rule: a service needs a `.demo.ts` shadow only if it imports `db`
 * (directly from `'../db'`, `'./db'`, or `'@/lib/db'`).
 * Pure utility files that never touch the database are exempt from this check.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SERVICES_DIR = path.resolve(__dirname, '../services');

/** Regex to detect a direct db import in a service source file. */
const DB_IMPORT_RE = /from\s+['"](\.\.?\/db|@\/lib\/db)['"]/;

function extractExportedFunctions(source: string): string[] {
  const names: string[] = [];

  // Pattern 1: export (async )?function name
  const functionPattern = /^export (?:async )?function (\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = functionPattern.exec(source)) !== null) {
    names.push(match[1]);
  }

  // Pattern 2: export const name = (async )?(
  const constArrowPattern = /^export const (\w+) = (?:async )?\(/gm;
  while ((match = constArrowPattern.exec(source)) !== null) {
    names.push(match[1]);
  }

  // Pattern 3: export const name = (async )?function
  const constFunctionPattern = /^export const (\w+) = (?:async )?function/gm;
  while ((match = constFunctionPattern.exec(source)) !== null) {
    names.push(match[1]);
  }

  return names;
}

describe('demo-coverage — every service function has a demo shadow', () => {
  const realServiceFiles = readdirSync(SERVICES_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.demo.ts') && !f.endsWith('.test.ts'),
  );

  for (const realFile of realServiceFiles) {
    const basename = realFile.replace(/\.ts$/, '');
    const realPath = path.join(SERVICES_DIR, realFile);
    const demoPath = path.join(SERVICES_DIR, `${basename}.demo.ts`);
    const realSource = readFileSync(realPath, 'utf8');

    // Only services that import `db` need a demo shadow.
    // Pure utility files (no DB access) are exempt — skip them entirely.
    if (!DB_IMPORT_RE.test(realSource)) continue;

    const realExports = extractExportedFunctions(realSource);

    // Skip files with no exported functions (e.g., pure types files or constants-only files)
    if (realExports.length === 0) continue;

    it(`${realFile} has a demo shadow`, () => {
      expect(
        existsSync(demoPath),
        `Missing demo shadow: ${demoPath}. Every service with exported functions must have a sibling .demo.ts for demo mode.`,
      ).toBe(true);
    });

    it(`${realFile} demo shadow exports all real functions`, () => {
      if (!existsSync(demoPath)) return; // other assertion will fail
      const demoSource = readFileSync(demoPath, 'utf8');
      const demoExports = extractExportedFunctions(demoSource);
      const missing = realExports.filter((name) => !demoExports.includes(name));
      expect(
        missing,
        `${realFile} exports [${missing.join(', ')}] but ${basename}.demo.ts does not. Add demo shadows for each missing function.`,
      ).toEqual([]);
    });
  }
});

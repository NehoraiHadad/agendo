/**
 * Tests for terminal frame fixtures.
 *
 * 1. Every fixture is non-empty.
 * 2. Every fixture's frames are in atMs ascending order.
 * 3. Each frame's data is non-empty.
 * 4. DEMO_TERMINAL_FRAMES has exactly 3 keys matching the 3 canonical session IDs.
 * 5. No frame's data contains the forbidden alternate-screen escape [?1049.
 */

import { describe, it, expect } from 'vitest';
import {
  claudeExploreFrames,
  codexRefactorFrames,
  geminiPlanFrames,
  DEMO_TERMINAL_FRAMES,
  type TerminalFrame,
} from '../index';

const CANONICAL_IDS = [
  '77777777-7777-4777-a777-777777777777',
  '88888888-8888-4888-a888-888888888888',
  '99999999-9999-4999-a999-999999999999',
] as const;

describe('TerminalFrame fixtures', () => {
  describe('claudeExploreFrames', () => {
    it('is non-empty', () => {
      expect(claudeExploreFrames.length).toBeGreaterThan(0);
    });

    it('frames are in ascending atMs order', () => {
      for (let i = 1; i < claudeExploreFrames.length; i++) {
        expect(claudeExploreFrames[i].atMs).toBeGreaterThanOrEqual(claudeExploreFrames[i - 1].atMs);
      }
    });

    it('every frame has non-empty data', () => {
      for (const frame of claudeExploreFrames) {
        expect(frame.data.length).toBeGreaterThan(0);
      }
    });

    it('no frame uses the alternate-screen escape sequence', () => {
      for (const frame of claudeExploreFrames) {
        expect(frame.data).not.toContain('[?1049');
      }
    });
  });

  describe('codexRefactorFrames', () => {
    it('is non-empty', () => {
      expect(codexRefactorFrames.length).toBeGreaterThan(0);
    });

    it('frames are in ascending atMs order', () => {
      for (let i = 1; i < codexRefactorFrames.length; i++) {
        expect(codexRefactorFrames[i].atMs).toBeGreaterThanOrEqual(codexRefactorFrames[i - 1].atMs);
      }
    });

    it('every frame has non-empty data', () => {
      for (const frame of codexRefactorFrames) {
        expect(frame.data.length).toBeGreaterThan(0);
      }
    });

    it('no frame uses the alternate-screen escape sequence', () => {
      for (const frame of codexRefactorFrames) {
        expect(frame.data).not.toContain('[?1049');
      }
    });
  });

  describe('geminiPlanFrames', () => {
    it('is non-empty', () => {
      expect(geminiPlanFrames.length).toBeGreaterThan(0);
    });

    it('frames are in ascending atMs order', () => {
      for (let i = 1; i < geminiPlanFrames.length; i++) {
        expect(geminiPlanFrames[i].atMs).toBeGreaterThanOrEqual(geminiPlanFrames[i - 1].atMs);
      }
    });

    it('every frame has non-empty data', () => {
      for (const frame of geminiPlanFrames) {
        expect(frame.data.length).toBeGreaterThan(0);
      }
    });

    it('no frame uses the alternate-screen escape sequence', () => {
      for (const frame of geminiPlanFrames) {
        expect(frame.data).not.toContain('[?1049');
      }
    });
  });

  describe('DEMO_TERMINAL_FRAMES map', () => {
    it('has exactly 3 keys', () => {
      expect(Object.keys(DEMO_TERMINAL_FRAMES)).toHaveLength(3);
    });

    it('contains all 3 canonical session IDs', () => {
      for (const id of CANONICAL_IDS) {
        expect(DEMO_TERMINAL_FRAMES).toHaveProperty(id);
      }
    });

    it('maps each ID to its corresponding fixture array', () => {
      expect(DEMO_TERMINAL_FRAMES['77777777-7777-4777-a777-777777777777']).toBe(
        claudeExploreFrames,
      );
      expect(DEMO_TERMINAL_FRAMES['88888888-8888-4888-a888-888888888888']).toBe(
        codexRefactorFrames,
      );
      expect(DEMO_TERMINAL_FRAMES['99999999-9999-4999-a999-999999999999']).toBe(geminiPlanFrames);
    });

    it('every entry in the map is a non-empty array of TerminalFrames', () => {
      for (const [, frames] of Object.entries(DEMO_TERMINAL_FRAMES)) {
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
          const f = frame as TerminalFrame;
          expect(typeof f.atMs).toBe('number');
          expect(typeof f.data).toBe('string');
          expect(f.data.length).toBeGreaterThan(0);
        }
      }
    });
  });
});

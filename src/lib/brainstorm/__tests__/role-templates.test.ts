/**
 * Tests for role-templates.ts
 *
 * Verifies that DEFAULT_ROLE_INSTRUCTIONS provides instructions for all expected
 * roles and that AUTO_ROLE_ASSIGNMENTS covers 2, 3, and 4 participants.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLE_INSTRUCTIONS, AUTO_ROLE_ASSIGNMENTS } from '../role-templates';

describe('DEFAULT_ROLE_INSTRUCTIONS', () => {
  it('has instructions for the critic role', () => {
    expect(DEFAULT_ROLE_INSTRUCTIONS['critic']).toBeDefined();
    expect(DEFAULT_ROLE_INSTRUCTIONS['critic'].length).toBeGreaterThan(0);
    expect(DEFAULT_ROLE_INSTRUCTIONS['critic']).toContain('CRITIC');
  });

  it('has instructions for the optimist role', () => {
    expect(DEFAULT_ROLE_INSTRUCTIONS['optimist']).toBeDefined();
    expect(DEFAULT_ROLE_INSTRUCTIONS['optimist'].length).toBeGreaterThan(0);
    expect(DEFAULT_ROLE_INSTRUCTIONS['optimist']).toContain('OPTIMIST');
  });

  it('has instructions for the pragmatist role', () => {
    expect(DEFAULT_ROLE_INSTRUCTIONS['pragmatist']).toBeDefined();
    expect(DEFAULT_ROLE_INSTRUCTIONS['pragmatist'].length).toBeGreaterThan(0);
    expect(DEFAULT_ROLE_INSTRUCTIONS['pragmatist']).toContain('PRAGMATIST');
  });

  it('has instructions for the architect role', () => {
    expect(DEFAULT_ROLE_INSTRUCTIONS['architect']).toBeDefined();
    expect(DEFAULT_ROLE_INSTRUCTIONS['architect'].length).toBeGreaterThan(0);
    expect(DEFAULT_ROLE_INSTRUCTIONS['architect']).toContain('ARCHITECT');
  });

  it('all default role instructions are non-empty strings', () => {
    for (const [role, instructions] of Object.entries(DEFAULT_ROLE_INSTRUCTIONS)) {
      expect(typeof instructions, `role "${role}" instructions`).toBe('string');
      expect(
        instructions.trim().length,
        `role "${role}" instructions must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('AUTO_ROLE_ASSIGNMENTS', () => {
  it('covers 2 participants', () => {
    const roles = AUTO_ROLE_ASSIGNMENTS[2];
    expect(roles).toBeDefined();
    expect(roles).toHaveLength(2);
  });

  it('covers 3 participants', () => {
    const roles = AUTO_ROLE_ASSIGNMENTS[3];
    expect(roles).toBeDefined();
    expect(roles).toHaveLength(3);
  });

  it('covers 4 participants', () => {
    const roles = AUTO_ROLE_ASSIGNMENTS[4];
    expect(roles).toBeDefined();
    expect(roles).toHaveLength(4);
  });

  it('all auto-assigned roles reference valid default instructions', () => {
    for (const [count, roles] of Object.entries(AUTO_ROLE_ASSIGNMENTS)) {
      for (const role of roles) {
        expect(
          DEFAULT_ROLE_INSTRUCTIONS[role],
          `role "${role}" for count ${count} must have default instructions`,
        ).toBeDefined();
      }
    }
  });

  it('2-participant assignment uses critic and pragmatist', () => {
    expect(AUTO_ROLE_ASSIGNMENTS[2]).toContain('critic');
    expect(AUTO_ROLE_ASSIGNMENTS[2]).toContain('pragmatist');
  });

  it('3-participant assignment includes optimist', () => {
    expect(AUTO_ROLE_ASSIGNMENTS[3]).toContain('optimist');
  });

  it('4-participant assignment includes architect', () => {
    expect(AUTO_ROLE_ASSIGNMENTS[4]).toContain('architect');
  });
});

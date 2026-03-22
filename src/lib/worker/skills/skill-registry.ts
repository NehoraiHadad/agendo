/**
 * Skill Registry — loads skill content from bundled markdown files.
 *
 * Skills are installed as SKILL.md files to ~/.agents/skills/ at worker startup
 * (see install-skills.ts). Each CLI discovers them natively via the Agent Skills standard.
 *
 * Build strategy:
 * - esbuild (production): --loader:.md=text inlines .md as string constants
 * - tsx (development): readFileSync fallback at startup
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Skill {
  /** Unique skill identifier (e.g., 'agendo-workflow', 'artifact-design') */
  name: string;
  /** Short description for skill discovery */
  description: string;
  /** Full markdown content of the skill */
  content: string;
}

/** Skill definitions: name → description + filename */
const SKILL_DEFS = [
  {
    name: 'agendo-workflow',
    description:
      'Agendo task management workflow: task lifecycle, MCP tool reference, multi-agent coordination',
    filename: 'agendo/SKILL.md',
  },
  {
    name: 'artifact-design',
    description:
      'Design guidelines for render_artifact: typography, color, motion, layout, and technical constraints',
    filename: 'artifact-design.md',
  },
  {
    name: 'brainstorm-persona-claude',
    description:
      'Provider-aware brainstorm persona for Claude participants: architecture, critique, and convergence strengths',
    filename: 'brainstorm-persona-claude.md',
  },
  {
    name: 'brainstorm-persona-codex',
    description:
      'Provider-aware brainstorm persona for Codex participants: implementation realism, testing, and focused execution',
    filename: 'brainstorm-persona-codex.md',
  },
  {
    name: 'brainstorm-persona-gemini',
    description:
      'Provider-aware brainstorm persona for Gemini participants: alternatives, ecosystem context, and broad exploration',
    filename: 'brainstorm-persona-gemini.md',
  },
  {
    name: 'brainstorm-persona-copilot',
    description:
      'Provider-aware brainstorm persona for Copilot participants: workflow hygiene, guardrails, and concise execution support',
    filename: 'brainstorm-persona-copilot.md',
  },
] as const;

/**
 * Load skill content from a .md file.
 *
 * First tries to require() the file (works with esbuild --loader:.md=text).
 * Falls back to readFileSync from the source directory (works with tsx in dev).
 */
function loadSkillContent(filename: string): string {
  // Try esbuild text loader first (production build)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const content = require(`./${filename}`);
    // esbuild text loader exports { default: string } for ESM or string for CJS
    if (typeof content === 'string') return content;
    if (typeof content?.default === 'string') return content.default;
  } catch {
    // Not in esbuild bundle — fall through to readFileSync
  }

  // Fallback: read from source directory (dev mode with tsx)
  try {
    return readFileSync(join(__dirname, filename), 'utf-8');
  } catch {
    // File not found
    return '';
  }
}

/** All registered skills, loaded at module init. */
const ALL_SKILLS: Skill[] = SKILL_DEFS.map((def) => ({
  name: def.name,
  description: def.description,
  content: loadSkillContent(def.filename),
})).filter((s) => s.content.length > 0);

/** Skill lookup by name. */
const skillMap = new Map<string, Skill>(ALL_SKILLS.map((s) => [s.name, s]));

/**
 * Load a skill by name.
 */
export function loadSkill(name: string): Skill | null {
  return skillMap.get(name) ?? null;
}

/**
 * Load all registered skills.
 */
export function loadAllSkills(): Skill[] {
  return [...ALL_SKILLS];
}

/**
 * Get skill content by name. Returns empty string if not found.
 */
export function getSkillContent(name: string): string {
  return skillMap.get(name)?.content ?? '';
}

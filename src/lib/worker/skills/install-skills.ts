/**
 * Install/update SKILL.md files for native CLI discovery.
 *
 * Called once at worker startup. Idempotent — only writes when content differs.
 *
 * Strategy:
 * - Files written to ~/.agents/skills/ (Agent Skills standard — single source of truth)
 * - Symlinks created from ~/.claude/skills/ → ~/.agents/skills/ (Claude Code discovery)
 * - Same pattern already used by remotion-best-practices and agent-browser
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { createLogger } from '@/lib/logger';
import { loadAllSkills, type Skill } from './skill-registry';

const log = createLogger('skill-installer');

/** Map registry skill names to the SKILL.md directory names and frontmatter descriptions. */
const SKILL_META: Record<string, { dirName: string; description: string }> = {
  'agendo-workflow': {
    dirName: 'agendo',
    description: `Expert guidance for working inside Agendo task management sessions.
  Use when mcp__agendo__* tools are available. Covers task lifecycle, progress tracking,
  multi-agent orchestration, status transitions, planning mode, and permission modes.
  Activate this skill whenever the system prompt mentions "Agendo", "task_id", or
  "mcp__agendo__", or when deferred tools include agendo MCP tools like get_my_task,
  update_task, create_task, add_progress_note, start_agent_session, or save_plan.
  Also use when coordinating work across multiple AI agents, managing task status
  transitions (todo/in_progress/done/blocked), or spawning agent sessions.`,
  },
  'artifact-design': {
    dirName: 'agendo-artifact-design',
    description: `Design guidelines for render_artifact: typography, color, motion, layout, and technical constraints.`,
  },
};

/**
 * Build a SKILL.md file with YAML frontmatter.
 */
function buildSkillFile(skill: Skill, meta: { dirName: string; description: string }): string {
  // Indent description lines for YAML block scalar
  const descLines = meta.description.trim().split('\n');
  const yamlDesc = descLines.map((line) => `  ${line}`).join('\n');

  return `---
name: ${meta.dirName}
description: |
${yamlDesc}
---

${skill.content.trim()}
`;
}

function md5(content: string): string {
  return createHash('md5').update(content, 'utf-8').digest('hex');
}

/** Source of truth: ~/.agents/skills/ (Agent Skills standard) */
const AGENTS_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** Symlink target: ~/.claude/skills/ (Claude Code discovery) */
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/**
 * Ensure a symlink exists from ~/.claude/skills/{name} → ~/.agents/skills/{name}.
 * If a real directory already exists at the symlink path, it is replaced.
 */
function ensureSymlink(dirName: string): void {
  const target = join(AGENTS_SKILLS_DIR, dirName);
  const link = join(CLAUDE_SKILLS_DIR, dirName);

  // Use relative path for portability (matches existing remotion-best-practices pattern)
  const relTarget = relative(CLAUDE_SKILLS_DIR, target);

  // Already a correct symlink?
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(link) === relTarget) return; // already correct
      unlinkSync(link); // wrong target — recreate
    } else {
      // Real directory/file at link path — remove it so we can symlink
      // (e.g. leftover from when installSkills wrote files to both locations)
      unlinkSync(link);
    }
  } catch {
    // Doesn't exist — will create below
  }

  try {
    mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
    symlinkSync(relTarget, link);
    log.info({ dirName, link, target: relTarget }, 'Created symlink for Claude skill discovery');
  } catch (err) {
    log.warn({ err, dirName }, 'Failed to create Claude skills symlink');
  }
}

/**
 * Install all SKILL.md files to ~/.agents/skills/ and symlink from ~/.claude/skills/.
 * Idempotent: only writes when content has changed, only creates symlinks when missing.
 */
export async function installSkills(): Promise<void> {
  const skills = loadAllSkills();
  if (skills.length === 0) {
    log.warn('No skills loaded from registry — skipping SKILL.md installation');
    return;
  }

  try {
    mkdirSync(AGENTS_SKILLS_DIR, { recursive: true });
  } catch (err) {
    log.warn({ err }, `Cannot create ${AGENTS_SKILLS_DIR} — skipping SKILL.md installation`);
    return;
  }

  let installed = 0;
  let skipped = 0;

  for (const skill of skills) {
    const meta = SKILL_META[skill.name];
    if (!meta) {
      log.warn({ skillName: skill.name }, 'No SKILL_META mapping — skipping');
      continue;
    }

    const skillDir = join(AGENTS_SKILLS_DIR, meta.dirName);
    const skillFile = join(skillDir, 'SKILL.md');
    const newContent = buildSkillFile(skill, meta);
    const newHash = md5(newContent);

    // Check if existing file matches
    if (existsSync(skillFile)) {
      try {
        const existing = readFileSync(skillFile, 'utf-8');
        if (md5(existing) === newHash) {
          skipped++;
          // Still ensure symlink exists even if content hasn't changed
          ensureSymlink(meta.dirName);
          continue;
        }
      } catch {
        // Can't read existing file — overwrite it
      }
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, newContent, 'utf-8');
      installed++;
      log.info({ skill: meta.dirName, path: skillFile }, 'Installed SKILL.md');
    } catch (err) {
      log.warn({ err, skill: meta.dirName }, 'Failed to write SKILL.md — skipping');
      continue;
    }

    // Symlink from ~/.claude/skills/ → ~/.agents/skills/ for Claude discovery
    ensureSymlink(meta.dirName);
  }

  log.info({ installed, skipped, total: skills.length }, 'SKILL.md installation complete');
}

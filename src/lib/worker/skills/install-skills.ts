/**
 * Install/update skill files for native CLI discovery.
 *
 * Called once at worker startup. Idempotent — only writes when content differs.
 *
 * Strategy:
 * - Files written to ~/.agents/skills/ (Agent Skills standard — single source of truth)
 * - Symlinks created from ~/.claude/skills/ → ~/.agents/skills/ (Claude Code discovery)
 * - Same pattern already used by remotion-best-practices and agent-browser
 *
 * Supports two skill layouts:
 * - Single file: `skill-name.md` → deployed as `SKILL.md`
 * - Multi-file directory: `skill-name/SKILL.md` + `skill-name/references/*.md`
 *   → entire directory deployed (SKILL.md + references/)
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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

/** Additional files to deploy alongside SKILL.md for multi-file skills. */
interface SkillExtraFiles {
  /** Source directory containing additional files (relative to skills/) */
  sourceDir: string;
  /** Subdirectories to copy (e.g. ['references']) */
  subdirs: string[];
}

/** Map registry skill names to the SKILL.md directory names and frontmatter descriptions. */
const SKILL_META: Record<
  string,
  { dirName: string; description: string; extraFiles?: SkillExtraFiles }
> = {
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
    extraFiles: {
      sourceDir: 'agendo',
      subdirs: ['references'],
    },
  },
  'artifact-design': {
    dirName: 'agendo-artifact-design',
    description: `Design guidelines for render_artifact: typography, color, motion, layout, and technical constraints.`,
  },
  'brainstorm-persona-claude': {
    dirName: 'brainstorm-persona-claude',
    description: `[DEPRECATED — use brainstorm-role-* skills instead] Provider-aware brainstorm persona for Claude participants.`,
  },
  'brainstorm-persona-codex': {
    dirName: 'brainstorm-persona-codex',
    description: `[DEPRECATED — use brainstorm-role-* skills instead] Provider-aware brainstorm persona for Codex participants.`,
  },
  'brainstorm-persona-gemini': {
    dirName: 'brainstorm-persona-gemini',
    description: `[DEPRECATED — use brainstorm-role-* skills instead] Provider-aware brainstorm persona for Gemini participants.`,
  },
  'brainstorm-persona-copilot': {
    dirName: 'brainstorm-persona-copilot',
    description: `[DEPRECATED — use brainstorm-role-* skills instead] Provider-aware brainstorm persona for Copilot participants.`,
  },
  'brainstorm-protocol': {
    dirName: 'brainstorm-protocol',
    description: `Core brainstorm protocol skill. Always loaded for brainstorm participants.
  Explains wave mechanics, turn structure, MCP signaling (brainstorm_signal/brainstorm_get_state),
  leader concept, and quality expectations. Activate for any multi-agent brainstorm session.`,
  },
  'brainstorm-role-critic': {
    dirName: 'brainstorm-role-critic',
    description: `Brainstorm role persona for the Critic. Loaded when a brainstorm participant
  is assigned the critic role. Defines stance, phase behavior, and success criteria
  for finding weaknesses and challenging assumptions.`,
  },
  'brainstorm-role-optimist': {
    dirName: 'brainstorm-role-optimist',
    description: `Brainstorm role persona for the Optimist. Loaded when a brainstorm participant
  is assigned the optimist role. Defines stance, phase behavior, and success criteria
  for finding potential and championing high-value approaches.`,
  },
  'brainstorm-role-pragmatist': {
    dirName: 'brainstorm-role-pragmatist',
    description: `Brainstorm role persona for the Pragmatist. Loaded when a brainstorm participant
  is assigned the pragmatist role. Defines stance, phase behavior, and success criteria
  for grounding discussion in implementation reality.`,
  },
  'brainstorm-role-architect': {
    dirName: 'brainstorm-role-architect',
    description: `Brainstorm role persona for the Architect. Loaded when a brainstorm participant
  is assigned the architect role. Defines stance, phase behavior, and success criteria
  for system-level thinking, interfaces, and boundaries.`,
  },
  'brainstorm-role-wildcard': {
    dirName: 'brainstorm-role-wildcard',
    description: `Brainstorm role persona for the Wildcard. Loaded when a brainstorm participant
  is assigned the wildcard role. Defines stance, phase behavior, and success criteria
  for unconventional perspectives and challenging groupthink.`,
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
 * Resolve the source directory for skill files.
 * In production (esbuild bundle), __dirname is dist/worker/.
 * In dev (tsx), __dirname is src/lib/worker/skills/.
 * We detect by checking if the source dir exists.
 */
function resolveSkillSourceDir(): string {
  // Try source directory first (dev mode with tsx)
  const srcDir = join(__dirname);
  const devDir = join(srcDir);
  if (existsSync(join(devDir, 'agendo', 'references'))) {
    return devDir;
  }
  // In esbuild bundle, fall back to the project's source directory
  // (extra files aren't bundled — read from the repo checkout)
  const projectRoot = process.env.AGENDO_PROJECT_ROOT ?? join(homedir(), 'projects', 'agendo');
  return join(projectRoot, 'src', 'lib', 'worker', 'skills');
}

/**
 * Install extra files (references/, etc.) from a skill's source directory.
 * Writes each file individually, only when content has changed.
 */
function installExtraFiles(
  extraFiles: SkillExtraFiles,
  destDir: string,
): { installed: number; skipped: number } {
  const sourceBase = resolveSkillSourceDir();
  let installed = 0;
  let skipped = 0;

  for (const subdir of extraFiles.subdirs) {
    const srcSubdir = join(sourceBase, extraFiles.sourceDir, subdir);
    const destSubdir = join(destDir, subdir);

    if (!existsSync(srcSubdir)) {
      log.warn({ srcSubdir }, 'Skill extra files source directory not found — skipping');
      continue;
    }

    mkdirSync(destSubdir, { recursive: true });

    const files = readdirSync(srcSubdir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const srcPath = join(srcSubdir, file);
      const destPath = join(destSubdir, file);

      const newContent = readFileSync(srcPath, 'utf-8');
      const newHash = md5(newContent);

      if (existsSync(destPath)) {
        try {
          const existing = readFileSync(destPath, 'utf-8');
          if (md5(existing) === newHash) {
            skipped++;
            continue;
          }
        } catch {
          // Can't read existing — overwrite
        }
      }

      writeFileSync(destPath, newContent, 'utf-8');
      installed++;
      log.info({ path: destPath }, 'Installed skill reference file');
    }
  }

  return { installed, skipped };
}

/**
 * Install all skill files to ~/.agents/skills/ and symlink from ~/.claude/skills/.
 * Idempotent: only writes when content has changed, only creates symlinks when missing.
 */
export async function installSkills(): Promise<void> {
  const skills = loadAllSkills();
  if (skills.length === 0) {
    log.warn('No skills loaded from registry — skipping skill installation');
    return;
  }

  try {
    mkdirSync(AGENTS_SKILLS_DIR, { recursive: true });
  } catch (err) {
    log.warn({ err }, `Cannot create ${AGENTS_SKILLS_DIR} — skipping skill installation`);
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
    let skillChanged = true;
    if (existsSync(skillFile)) {
      try {
        const existing = readFileSync(skillFile, 'utf-8');
        if (md5(existing) === newHash) {
          skillChanged = false;
          skipped++;
        }
      } catch {
        // Can't read existing file — overwrite it
      }
    }

    if (skillChanged) {
      try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillFile, newContent, 'utf-8');
        installed++;
        log.info({ skill: meta.dirName, path: skillFile }, 'Installed SKILL.md');
      } catch (err) {
        log.warn({ err, skill: meta.dirName }, 'Failed to write SKILL.md — skipping');
        continue;
      }
    }

    // Install extra files (references/, etc.) for multi-file skills
    if (meta.extraFiles) {
      const extraResult = installExtraFiles(meta.extraFiles, skillDir);
      installed += extraResult.installed;
      skipped += extraResult.skipped;
    }

    // Symlink from ~/.claude/skills/ → ~/.agents/skills/ for Claude discovery
    ensureSymlink(meta.dirName);
  }

  log.info({ installed, skipped, total: skills.length }, 'Skill installation complete');
}

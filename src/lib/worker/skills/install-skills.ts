/**
 * Install/update SKILL.md files to ~/.agents/skills/ for native CLI discovery.
 *
 * Called once at worker startup. Idempotent — only writes when content differs.
 * Follows the Agent Skills standard: ~/.agents/skills/{skill-name}/SKILL.md
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@/lib/logger';
import { loadAllSkills, type Skill } from './skill-registry';

const log = createLogger('skill-installer');

/** Map registry skill names to the SKILL.md directory names and frontmatter descriptions. */
const SKILL_META: Record<string, { dirName: string; description: string }> = {
  'agendo-workflow': {
    dirName: 'agendo-task-workflow',
    description: `Use this skill when working with Agendo MCP tools (mcp__agendo__*).
  Covers task lifecycle, progress tracking, multi-agent coordination.`,
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

/**
 * Install all SKILL.md files to ~/.agents/skills/.
 * Idempotent: only writes when content has changed.
 */
export async function installSkills(): Promise<void> {
  const skills = loadAllSkills();
  if (skills.length === 0) {
    log.warn('No skills loaded from registry — skipping SKILL.md installation');
    return;
  }

  const baseDir = join(homedir(), '.agents', 'skills');

  try {
    mkdirSync(baseDir, { recursive: true });
  } catch (err) {
    log.warn({ err }, `Cannot create ${baseDir} — skipping SKILL.md installation`);
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

    const skillDir = join(baseDir, meta.dirName);
    const skillFile = join(skillDir, 'SKILL.md');
    const newContent = buildSkillFile(skill, meta);
    const newHash = md5(newContent);

    // Check if existing file matches
    if (existsSync(skillFile)) {
      try {
        const existing = readFileSync(skillFile, 'utf-8');
        if (md5(existing) === newHash) {
          skipped++;
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
    }
  }

  log.info({ installed, skipped, total: skills.length }, 'SKILL.md installation complete');
}

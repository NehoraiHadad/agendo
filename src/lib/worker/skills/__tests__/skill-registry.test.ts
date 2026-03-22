import { describe, it, expect } from 'vitest';
import { loadSkill, loadAllSkills, getSkillContent } from '../skill-registry';

describe('skill-registry', () => {
  describe('loadSkill', () => {
    it('loads agendo-workflow skill', () => {
      const skill = loadSkill('agendo-workflow');
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('agendo-workflow');
      expect(skill!.content).toContain('Agendo Agent Guide');
      expect(skill!.content).toContain('get_my_task');
    });

    it('loads artifact-design skill', () => {
      const skill = loadSkill('artifact-design');
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('artifact-design');
      expect(skill!.content).toContain('Artifact Design Guidelines');
      expect(skill!.content).toContain('render_artifact');
    });

    it('loads brainstorm persona skills', () => {
      const claudeSkill = loadSkill('brainstorm-persona-claude');
      const codexSkill = loadSkill('brainstorm-persona-codex');
      const geminiSkill = loadSkill('brainstorm-persona-gemini');
      const copilotSkill = loadSkill('brainstorm-persona-copilot');

      expect(claudeSkill?.content).toContain('Claude Brainstorm Persona');
      expect(codexSkill?.content).toContain('Codex Brainstorm Persona');
      expect(geminiSkill?.content).toContain('Gemini Brainstorm Persona');
      expect(copilotSkill?.content).toContain('Copilot Brainstorm Persona');
    });

    it('returns null for unknown skill', () => {
      expect(loadSkill('nonexistent')).toBeNull();
    });
  });

  describe('loadAllSkills', () => {
    it('returns all registered skills', () => {
      const skills = loadAllSkills();
      expect(skills.length).toBeGreaterThanOrEqual(6);
      const names = skills.map((s) => s.name);
      expect(names).toContain('agendo-workflow');
      expect(names).toContain('artifact-design');
      expect(names).toContain('brainstorm-persona-claude');
      expect(names).toContain('brainstorm-persona-codex');
      expect(names).toContain('brainstorm-persona-gemini');
      expect(names).toContain('brainstorm-persona-copilot');
    });
  });

  describe('getSkillContent', () => {
    it('returns content for known skill', () => {
      const content = getSkillContent('agendo-workflow');
      expect(content).toContain('Agendo Agent Guide');
    });

    it('returns empty string for unknown skill', () => {
      expect(getSkillContent('nonexistent')).toBe('');
    });
  });
});

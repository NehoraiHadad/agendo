import { describe, it, expect } from 'vitest';
import { loadSkill, loadAllSkills, getSkillContent } from '../skill-registry';

describe('skill-registry', () => {
  describe('loadSkill', () => {
    it('loads agendo-workflow skill', () => {
      const skill = loadSkill('agendo-workflow');
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('agendo-workflow');
      expect(skill!.content).toContain('Agendo Task Workflow');
      expect(skill!.content).toContain('get_my_task');
    });

    it('loads artifact-design skill', () => {
      const skill = loadSkill('artifact-design');
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('artifact-design');
      expect(skill!.content).toContain('Artifact Design Guidelines');
      expect(skill!.content).toContain('render_artifact');
    });

    it('returns null for unknown skill', () => {
      expect(loadSkill('nonexistent')).toBeNull();
    });
  });

  describe('loadAllSkills', () => {
    it('returns all registered skills', () => {
      const skills = loadAllSkills();
      expect(skills.length).toBeGreaterThanOrEqual(2);
      const names = skills.map((s) => s.name);
      expect(names).toContain('agendo-workflow');
      expect(names).toContain('artifact-design');
    });
  });

  describe('getSkillContent', () => {
    it('returns content for known skill', () => {
      const content = getSkillContent('agendo-workflow');
      expect(content).toContain('Agendo Task Workflow');
    });

    it('returns empty string for unknown skill', () => {
      expect(getSkillContent('nonexistent')).toBe('');
    });
  });
});

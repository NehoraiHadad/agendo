import { describe, it, expect } from 'vitest';
import {
  generateSupportPreamble,
  generateExecutionPreamble,
  generatePlanningPreamble,
} from '../session-preambles';

describe('generateSupportPreamble', () => {
  it('includes system instructions header', () => {
    const preamble = generateSupportPreamble();
    expect(preamble).toContain('SYSTEM INSTRUCTIONS');
  });

  it('documents the GUIDE marker format', () => {
    const preamble = generateSupportPreamble();
    expect(preamble).toContain('[GUIDE:');
  });

  it('includes the navigation map', () => {
    const preamble = generateSupportPreamble();
    expect(preamble).toContain('Navigation Map');
    expect(preamble).toContain('Dashboard');
    expect(preamble).toContain('Settings');
    expect(preamble).toContain('Projects');
  });

  it('includes the bug reporting workflow', () => {
    const preamble = generateSupportPreamble();
    expect(preamble).toContain('gh issue create');
    expect(preamble).toContain('pm2 logs');
    expect(preamble).toContain('Bug Reporting');
  });

  it('does not include task or project context', () => {
    const preamble = generateSupportPreamble();
    expect(preamble).not.toContain('task_id=');
    expect(preamble).not.toContain('mode=planning');
  });
});

describe('generateExecutionPreamble', () => {
  it('includes task id and project name', () => {
    const preamble = generateExecutionPreamble('my-project', 'abc-123');
    expect(preamble).toContain('task_id=abc-123');
    expect(preamble).toContain('project=my-project');
  });
});

describe('generatePlanningPreamble', () => {
  it('includes planning mode', () => {
    const preamble = generatePlanningPreamble('my-project');
    expect(preamble).toContain('mode=planning');
    expect(preamble).toContain('project=my-project');
  });
});

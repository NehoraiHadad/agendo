import { describe, it, expect } from 'vitest';
import {
  generateSupportPreamble,
  generateExecutionPreamble,
  generatePlanningPreamble,
  generateTeamLeadPreamble,
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

  it('includes team delegation section when delegationPolicy is suggest', () => {
    const preamble = generateExecutionPreamble('proj', 'task-1', 'suggest');
    expect(preamble).toContain('Team Delegation');
    expect(preamble).toContain('create_team');
  });

  it('includes team delegation section when delegationPolicy is allow', () => {
    const preamble = generateExecutionPreamble('proj', 'task-1', 'allow');
    expect(preamble).toContain('Team Delegation');
  });

  it('excludes team delegation section when delegationPolicy is forbid', () => {
    const preamble = generateExecutionPreamble('proj', 'task-1', 'forbid');
    expect(preamble).not.toContain('Team Delegation');
    expect(preamble).not.toContain('create_team');
  });

  it('excludes team delegation section when no delegationPolicy is passed', () => {
    const preamble = generateExecutionPreamble('proj', 'task-1');
    expect(preamble).not.toContain('Team Delegation');
  });
});

describe('generatePlanningPreamble', () => {
  it('includes planning mode', () => {
    const preamble = generatePlanningPreamble('my-project');
    expect(preamble).toContain('mode=planning');
    expect(preamble).toContain('project=my-project');
  });

  it('includes team tools when delegationPolicy is suggest', () => {
    const preamble = generatePlanningPreamble('proj', 'suggest');
    expect(preamble).toContain('create_team');
    expect(preamble).toContain('get_team_status');
  });

  it('excludes team tools when delegationPolicy is forbid', () => {
    const preamble = generatePlanningPreamble('proj', 'forbid');
    expect(preamble).not.toContain('create_team');
    expect(preamble).not.toContain('get_team_status');
  });

  it('excludes team tools by default (no delegationPolicy)', () => {
    const preamble = generatePlanningPreamble('proj');
    expect(preamble).not.toContain('create_team');
  });
});

describe('generateTeamLeadPreamble', () => {
  it('includes task and project context', () => {
    const preamble = generateTeamLeadPreamble('my-project', 'task-uuid-123');
    expect(preamble).toContain('task_id=task-uuid-123');
    expect(preamble).toContain('project=my-project');
  });

  it('includes team orchestration tool names', () => {
    const preamble = generateTeamLeadPreamble('proj', 'task-1');
    expect(preamble).toContain('create_team');
    expect(preamble).toContain('get_team_status');
    expect(preamble).toContain('send_team_message');
  });

  it('includes agent slug examples', () => {
    const preamble = generateTeamLeadPreamble('proj', 'task-1');
    expect(preamble).toContain('claude-code-1');
    expect(preamble).toContain('codex-cli-1');
    expect(preamble).toContain('gemini-cli-1');
  });

  it('includes progress tracking guidance', () => {
    const preamble = generateTeamLeadPreamble('proj', 'task-1');
    expect(preamble).toContain('add_progress_note');
  });

  it('mentions monitoring pattern', () => {
    const preamble = generateTeamLeadPreamble('proj', 'task-1');
    expect(preamble.toLowerCase()).toContain('monitor');
  });

  it('includes team-lead mode marker', () => {
    const preamble = generateTeamLeadPreamble('proj', 'task-1');
    expect(preamble).toContain('mode=team-lead');
  });

  it('mentions that workers may send messages back', () => {
    const preamble = generateTeamLeadPreamble('proj', 'task-1');
    expect(preamble.toLowerCase()).toContain('worker');
    expect(preamble.toLowerCase()).toContain('message');
    // Should instruct the lead to check and respond to worker messages
    expect(preamble.toLowerCase()).toContain('respond');
  });
});

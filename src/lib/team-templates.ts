/**
 * Pre-built team templates for the Agent Team Canvas.
 * Each template defines nodes, edges, and agent configurations
 * that can be loaded into the canvas in one click.
 */

import type { Node, Edge } from '@xyflow/react';
import type { AgentNodeConfig, AgentNodeData } from '@/stores/team-canvas-store';

// ============================================================================
// Types
// ============================================================================

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  nodes: Node[];
  edges: Edge[];
  configs: Record<string, AgentNodeConfig>;
}

// ============================================================================
// Agent IDs (from seed data)
// ============================================================================

const AGENT_IDS = {
  claude: '4af57358-71fd-4577-a758-0135539b26c5',
  codex: '0a4add84-f5f7-4b25-aec6-d9e2e3f55c50',
  gemini: '48b18729-be2f-4d33-a38a-b46bda54b0f4',
  copilot: '9e0edc17-a4b3-4dd2-8f20-bb3b0e12f32c',
} as const;

// ============================================================================
// Helper to build node data
// ============================================================================

function agentNodeData(
  name: string,
  slug: string,
  agentId: string,
  accentColor: string,
): AgentNodeData {
  return { label: name, agentSlug: slug, agentId, agentName: name, accentColor };
}

function edgeStyle(color: string = '#6B7280'): Record<string, string | number> {
  return { stroke: color, strokeWidth: 2 };
}

// ============================================================================
// Templates
// ============================================================================

const fullStackTeam: TeamTemplate = {
  id: 'full-stack',
  name: 'Full Stack Team',
  description: 'Claude builds backend + frontend, with Codex for code review',
  icon: '🏗️',
  nodes: [
    {
      id: 'fs-backend',
      type: 'agentNode',
      position: { x: 100, y: 100 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
    {
      id: 'fs-frontend',
      type: 'agentNode',
      position: { x: 400, y: 100 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
    {
      id: 'fs-reviewer',
      type: 'agentNode',
      position: { x: 250, y: 300 },
      data: agentNodeData('Codex CLI', 'codex-cli-1', AGENT_IDS.codex, '#10B981'),
    },
  ],
  edges: [
    {
      id: 'fs-e1',
      source: 'fs-backend',
      target: 'fs-reviewer',
      type: 'smoothstep',
      animated: true,
      style: edgeStyle('#8B5CF6'),
    },
    {
      id: 'fs-e2',
      source: 'fs-frontend',
      target: 'fs-reviewer',
      type: 'smoothstep',
      animated: true,
      style: edgeStyle('#8B5CF6'),
    },
  ],
  configs: {
    'fs-backend': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'opus',
      permissionMode: 'bypassPermissions',
      initialPrompt:
        'You are the backend engineer. Implement the server-side logic, API routes, and database changes.',
      subtaskTitle: 'Backend Implementation',
    },
    'fs-frontend': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      initialPrompt:
        'You are the frontend engineer. Implement the UI components, pages, and client-side logic.',
      subtaskTitle: 'Frontend Implementation',
    },
    'fs-reviewer': {
      agentSlug: 'codex-cli-1',
      agentId: AGENT_IDS.codex,
      model: 'codex-mini',
      permissionMode: 'acceptEdits',
      initialPrompt:
        'You are the code reviewer. Review all changes made by the team for bugs, security issues, and code quality.',
      subtaskTitle: 'Code Review',
    },
  },
};

const tddTeam: TeamTemplate = {
  id: 'tdd',
  name: 'TDD Team',
  description: 'One agent writes tests first, another implements to make them pass',
  icon: '🧪',
  nodes: [
    {
      id: 'tdd-tests',
      type: 'agentNode',
      position: { x: 100, y: 150 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
    {
      id: 'tdd-impl',
      type: 'agentNode',
      position: { x: 400, y: 150 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
  ],
  edges: [
    {
      id: 'tdd-e1',
      source: 'tdd-tests',
      target: 'tdd-impl',
      type: 'smoothstep',
      animated: true,
      label: 'tests first →',
      style: edgeStyle('#8B5CF6'),
      labelStyle: { fill: '#d0d0e0', fontSize: 11 },
    },
  ],
  configs: {
    'tdd-tests': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      initialPrompt:
        'You are the test writer. Write comprehensive failing tests FIRST based on the requirements. Do NOT implement any production code. Only write tests.',
      subtaskTitle: 'Write Tests (Red Phase)',
    },
    'tdd-impl': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      initialPrompt:
        'You are the implementer. Write the minimal production code to make all tests pass. Run the tests after each change.',
      subtaskTitle: 'Implementation (Green Phase)',
    },
  },
};

const researchTeam: TeamTemplate = {
  id: 'research',
  name: 'Research Team',
  description: 'Claude researches and plans, Gemini provides design perspective',
  icon: '🔬',
  nodes: [
    {
      id: 'res-researcher',
      type: 'agentNode',
      position: { x: 100, y: 100 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
    {
      id: 'res-designer',
      type: 'agentNode',
      position: { x: 400, y: 100 },
      data: agentNodeData('Gemini CLI', 'gemini-cli-1', AGENT_IDS.gemini, '#3B82F6'),
    },
    {
      id: 'res-synthesizer',
      type: 'agentNode',
      position: { x: 250, y: 300 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
  ],
  edges: [
    {
      id: 'res-e1',
      source: 'res-researcher',
      target: 'res-synthesizer',
      type: 'smoothstep',
      animated: true,
      style: edgeStyle('#8B5CF6'),
    },
    {
      id: 'res-e2',
      source: 'res-designer',
      target: 'res-synthesizer',
      type: 'smoothstep',
      animated: true,
      style: edgeStyle('#3B82F6'),
    },
  ],
  configs: {
    'res-researcher': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'opus',
      permissionMode: 'acceptEdits',
      initialPrompt:
        'You are the researcher. Analyze the codebase, read documentation, and produce a comprehensive research document covering existing patterns, constraints, and recommendations.',
      subtaskTitle: 'Research & Analysis',
    },
    'res-designer': {
      agentSlug: 'gemini-cli-1',
      agentId: AGENT_IDS.gemini,
      model: 'gemini-2.5-pro',
      permissionMode: 'acceptEdits',
      initialPrompt:
        'You are the design architect. Analyze the codebase structure and produce a component architecture and design document with visual specifications.',
      subtaskTitle: 'Architecture & Design',
    },
    'res-synthesizer': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      initialPrompt:
        'You are the synthesis agent. Once research and design docs are ready, combine them into a final implementation plan and begin building.',
      subtaskTitle: 'Synthesis & Implementation',
    },
  },
};

const multiModelReview: TeamTemplate = {
  id: 'multi-model-review',
  name: 'Multi-Model Review',
  description: 'Three different AI models review the same code independently',
  icon: '🔍',
  nodes: [
    {
      id: 'mmr-claude',
      type: 'agentNode',
      position: { x: 50, y: 150 },
      data: agentNodeData('Claude Code', 'claude-code-1', AGENT_IDS.claude, '#8B5CF6'),
    },
    {
      id: 'mmr-codex',
      type: 'agentNode',
      position: { x: 250, y: 150 },
      data: agentNodeData('Codex CLI', 'codex-cli-1', AGENT_IDS.codex, '#10B981'),
    },
    {
      id: 'mmr-gemini',
      type: 'agentNode',
      position: { x: 450, y: 150 },
      data: agentNodeData('Gemini CLI', 'gemini-cli-1', AGENT_IDS.gemini, '#3B82F6'),
    },
  ],
  edges: [],
  configs: {
    'mmr-claude': {
      agentSlug: 'claude-code-1',
      agentId: AGENT_IDS.claude,
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      initialPrompt:
        'Review the code for bugs, logic errors, and security vulnerabilities. Provide a structured review with severity levels.',
      subtaskTitle: 'Claude Review',
    },
    'mmr-codex': {
      agentSlug: 'codex-cli-1',
      agentId: AGENT_IDS.codex,
      model: 'codex-mini',
      permissionMode: 'acceptEdits',
      initialPrompt:
        'Review the code for bugs, logic errors, and security vulnerabilities. Provide a structured review with severity levels.',
      subtaskTitle: 'Codex Review',
    },
    'mmr-gemini': {
      agentSlug: 'gemini-cli-1',
      agentId: AGENT_IDS.gemini,
      model: 'gemini-2.5-pro',
      permissionMode: 'acceptEdits',
      initialPrompt:
        'Review the code for bugs, logic errors, and security vulnerabilities. Provide a structured review with severity levels.',
      subtaskTitle: 'Gemini Review',
    },
  },
};

// ============================================================================
// Exports
// ============================================================================

export const TEAM_TEMPLATES: TeamTemplate[] = [
  fullStackTeam,
  tddTeam,
  researchTeam,
  multiModelReview,
];

export function getTemplateById(id: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find((t) => t.id === id);
}

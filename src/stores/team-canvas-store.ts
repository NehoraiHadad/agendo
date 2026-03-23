'use client';

import { create } from 'zustand';
import type { Node, Edge, OnNodesChange, OnEdgesChange, Connection } from '@xyflow/react';
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react';

// ============================================================================
// Types
// ============================================================================

export interface AgentNodeConfig {
  agentSlug: string;
  agentId: string;
  model: string;
  permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default';
  initialPrompt: string;
  subtaskTitle: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  slug: string;
  metadata: {
    icon?: string;
    color?: string;
    description?: string;
  } | null;
}

export type AgentNodeData = {
  label: string;
  agentSlug: string;
  agentId: string;
  agentName: string;
  accentColor: string;
};

export type TaskNodeData = {
  label: string;
  title: string;
  status: string;
  assigneeNodeId: string | null;
};

interface TeamCanvasState {
  // Core
  mode: 'build' | 'monitor';
  teamName: string;
  projectId: string | null;
  parentTaskId: string | null;

  // React Flow state
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;

  // Agent configs (keyed by node ID)
  agentConfigs: Record<string, AgentNodeConfig>;

  // Available agents cache
  availableAgents: AgentInfo[];

  // Actions — core
  setMode: (mode: 'build' | 'monitor') => void;
  setTeamName: (name: string) => void;
  setProjectId: (id: string | null) => void;
  setParentTaskId: (id: string | null) => void;
  setAvailableAgents: (agents: AgentInfo[]) => void;

  // Actions — nodes/edges
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;
  setSelectedNodeId: (id: string | null) => void;

  // Actions — agent nodes
  addAgentNode: (agent: AgentInfo, position: { x: number; y: number }) => void;
  removeNode: (nodeId: string) => void;
  updateAgentConfig: (nodeId: string, config: Partial<AgentNodeConfig>) => void;

  // Actions — task nodes
  addTaskNode: (title: string, position: { x: number; y: number }) => void;
  updateTaskNode: (nodeId: string, data: Partial<TaskNodeData>) => void;

  // Actions — templates
  loadTemplate: (
    nodes: Node[],
    edges: Edge[],
    configs: Record<string, AgentNodeConfig>,
    teamName: string,
  ) => void;
  reset: () => void;

  // Derived
  getAgentConfig: (nodeId: string) => AgentNodeConfig | undefined;
  getAgentNodeCount: () => number;
}

// ============================================================================
// Agent color mapping
// ============================================================================

const AGENT_ACCENT_COLORS: Record<string, string> = {
  claude: '#8B5CF6',
  codex: '#10B981',
  gemini: '#3B82F6',
  copilot: '#F59E0B',
};

export function getAgentAccentColor(slug: string): string {
  const normalized = slug.toLowerCase();
  for (const [prefix, color] of Object.entries(AGENT_ACCENT_COLORS)) {
    if (normalized.startsWith(prefix)) return color;
  }
  return '#6B7280'; // gray fallback
}

// ============================================================================
// Helpers
// ============================================================================

let nodeIdCounter = 0;

function generateNodeId(prefix: string): string {
  nodeIdCounter += 1;
  return `${prefix}-${Date.now()}-${nodeIdCounter}`;
}

const DEFAULT_MODEL_MAP: Record<string, string> = {
  claude: 'sonnet',
  codex: 'codex-mini',
  gemini: 'gemini-2.5-pro',
  copilot: 'gpt-4.1',
};

function getDefaultModel(slug: string): string {
  const normalized = slug.toLowerCase();
  for (const [prefix, model] of Object.entries(DEFAULT_MODEL_MAP)) {
    if (normalized.startsWith(prefix)) return model;
  }
  return 'default';
}

// ============================================================================
// Store
// ============================================================================

export const useTeamCanvasStore = create<TeamCanvasState>((set, get) => ({
  // Initial state
  mode: 'build',
  teamName: 'New Team',
  projectId: null,
  parentTaskId: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  agentConfigs: {},
  availableAgents: [],

  // Core setters
  setMode: (mode) => set({ mode }),
  setTeamName: (teamName) => set({ teamName }),
  setProjectId: (projectId) => set({ projectId }),
  setParentTaskId: (parentTaskId) => set({ parentTaskId }),
  setAvailableAgents: (availableAgents) => set({ availableAgents }),

  // React Flow handlers
  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },
  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },
  onConnect: (connection) => {
    set({
      edges: addEdge(
        {
          ...connection,
          type: 'smoothstep',
          animated: true,
          style: { stroke: '#6B7280', strokeWidth: 2 },
        },
        get().edges,
      ),
    });
  },

  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),

  // Agent node management
  addAgentNode: (agent, position) => {
    const id = generateNodeId('agent');
    const accentColor = getAgentAccentColor(agent.slug);

    const newNode: Node = {
      id,
      type: 'agentNode',
      position,
      data: {
        label: agent.name,
        agentSlug: agent.slug,
        agentId: agent.id,
        agentName: agent.name,
        accentColor,
      } satisfies AgentNodeData,
    };

    const config: AgentNodeConfig = {
      agentSlug: agent.slug,
      agentId: agent.id,
      model: getDefaultModel(agent.slug),
      permissionMode: 'bypassPermissions',
      initialPrompt: '',
      subtaskTitle: `${agent.name} task`,
    };

    set((state) => ({
      nodes: [...state.nodes, newNode],
      agentConfigs: { ...state.agentConfigs, [id]: config },
      selectedNodeId: id,
    }));
  },

  removeNode: (nodeId) => {
    set((state) => {
      const { [nodeId]: _removed, ...remainingConfigs } = state.agentConfigs;
      return {
        nodes: state.nodes.filter((n) => n.id !== nodeId),
        edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
        agentConfigs: remainingConfigs,
        selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      };
    });
  },

  updateAgentConfig: (nodeId, config) => {
    set((state) => {
      const existing = state.agentConfigs[nodeId];
      if (!existing) return state;
      return {
        agentConfigs: {
          ...state.agentConfigs,
          [nodeId]: { ...existing, ...config },
        },
      };
    });
  },

  // Task node management
  addTaskNode: (title, position) => {
    const id = generateNodeId('task');
    const newNode: Node = {
      id,
      type: 'taskNode',
      position,
      data: {
        label: title,
        title,
        status: 'todo',
        assigneeNodeId: null,
      } satisfies TaskNodeData,
    };

    set((state) => ({
      nodes: [...state.nodes, newNode],
      selectedNodeId: id,
    }));
  },

  updateTaskNode: (nodeId, data) => {
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
    }));
  },

  // Template loading
  loadTemplate: (nodes, edges, configs, teamName) => {
    // Reset counter for deterministic template IDs
    nodeIdCounter = 0;
    set({
      nodes,
      edges,
      agentConfigs: configs,
      teamName,
      selectedNodeId: null,
    });
  },

  reset: () => {
    nodeIdCounter = 0;
    set({
      nodes: [],
      edges: [],
      agentConfigs: {},
      teamName: 'New Team',
      selectedNodeId: null,
      parentTaskId: null,
    });
  },

  // Derived
  getAgentConfig: (nodeId) => get().agentConfigs[nodeId],
  getAgentNodeCount: () => get().nodes.filter((n) => n.type === 'agentNode').length,
}));

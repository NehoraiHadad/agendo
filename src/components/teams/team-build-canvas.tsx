'use client';

import { useCallback, useRef, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeTypes,
  type Node,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useTeamCanvasStore } from '@/stores/team-canvas-store';
import type { AgentInfo } from '@/stores/team-canvas-store';
import { AgentNode } from './agent-node';
import { TaskNode } from './task-node';
import { AgentPalette } from './agent-palette';
import { NodeConfigPanel } from './node-config-panel';
import { TeamCanvasToolbar } from './team-canvas-toolbar';

// ============================================================================
// Node types registration (must be stable reference)
// ============================================================================

const nodeTypes: NodeTypes = {
  agentNode: AgentNode,
  taskNode: TaskNode,
};

// ============================================================================
// Canvas drop zone styles
// ============================================================================

const proOptions = { hideAttribution: true };

const defaultEdgeOptions = {
  type: 'smoothstep' as const,
  animated: true,
  style: { stroke: '#6B7280', strokeWidth: 2 },
};

// ============================================================================
// Main Canvas
// ============================================================================

export function TeamBuildCanvas() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const nodes = useTeamCanvasStore((s) => s.nodes);
  const edges = useTeamCanvasStore((s) => s.edges);
  const onNodesChange = useTeamCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useTeamCanvasStore((s) => s.onEdgesChange);
  const onConnect = useTeamCanvasStore((s) => s.onConnect);
  const setSelectedNodeId = useTeamCanvasStore((s) => s.setSelectedNodeId);
  const addAgentNode = useTeamCanvasStore((s) => s.addAgentNode);
  const selectedNodeId = useTeamCanvasStore((s) => s.selectedNodeId);

  // Handle node click → select for config panel
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );

  // Handle pane click → deselect
  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // Handle drag over (from palette)
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // Handle drop (from palette → canvas)
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const agentData = event.dataTransfer.getData('application/agendo-agent');
      if (!agentData) return;

      let agent: AgentInfo;
      try {
        agent = JSON.parse(agentData) as AgentInfo;
      } catch {
        return;
      }

      // Get drop position relative to the canvas viewport
      const wrapper = reactFlowWrapper.current;
      if (!wrapper) return;

      const bounds = wrapper.getBoundingClientRect();
      const position = {
        x: event.clientX - bounds.left - 110, // offset for node width/2
        y: event.clientY - bounds.top - 40, // offset for node height/2
      };

      addAgentNode(agent, position);
    },
    [addAgentNode],
  );

  // Custom minimap node color
  const minimapNodeColor = useCallback(
    (node: { id: string; type?: string }) => {
      if (node.type === 'agentNode') {
        const agentNode = nodes.find((n) => n.id === node.id);
        if (agentNode) {
          return ((agentNode.data as Record<string, unknown>).accentColor as string) ?? '#8B5CF6';
        }
      }
      return '#6B7280';
    },
    [nodes],
  );

  // Apply selection styling
  const styledNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
      })),
    [nodes, selectedNodeId],
  );

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f]">
      {/* Toolbar */}
      <TeamCanvasToolbar />

      {/* Main content: palette + canvas + config */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Agent Palette */}
        <AgentPalette />

        {/* Center: React Flow Canvas */}
        <div
          ref={reactFlowWrapper}
          className="flex-1 min-w-0"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <ReactFlow
            nodes={styledNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            proOptions={proOptions}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.3}
            maxZoom={2}
            deleteKeyCode={['Backspace', 'Delete']}
            multiSelectionKeyCode="Shift"
            snapToGrid
            snapGrid={[20, 20]}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="rgba(100, 100, 140, 0.15)"
            />
            <Controls
              showInteractive={false}
              className="!bg-[#12121a] !border-white/[0.08] !shadow-lg [&>button]:!bg-[#12121a] [&>button]:!border-white/[0.06] [&>button]:!text-[#80809a] [&>button:hover]:!bg-white/[0.06]"
            />
            <MiniMap
              nodeColor={minimapNodeColor}
              maskColor="rgba(10, 10, 15, 0.85)"
              className="!bg-[#12121a] !border-white/[0.08]"
              pannable
              zoomable
            />
          </ReactFlow>
        </div>

        {/* Right: Config Panel */}
        <NodeConfigPanel />
      </div>
    </div>
  );
}

# Agent Team Canvas: Component Architecture & Design

This document outlines the component structure and state management for the Agent Team Canvas feature, which provides a "mission control" style interface for building and monitoring agent teams.

## Component Architecture

The UI is divided into two main modes: `BuildMode` for composing teams and `MonitorMode` for observing live execution. A responsive `MobileTeamView` is provided for smaller screens.

```
/teams/[taskId]
└── TeamCanvasPage
    ├── TeamCanvasProvider (Zustand)
    ├── TeamCanvasToolbar
    │   ├── TeamNameInput
    │   ├── TemplateSelector
    │   ├── ModeToggle (Build / Monitor)
    │   └── LaunchButton
    ├── BuildMode
    │   ├── AgentPalette
    │   │   └── DraggableAgentCard (using @dnd-kit/core)
    │   ├── CanvasWorkspace (React Flow - @xyflow/react)
    │   │   ├── AgentNode
    │   │   ├── TaskNode
    │   │   └── DependencyEdge
    │   └── NodeConfigPanel
    │       ├── ModelSelector
    │       ├── PermissionEditor
    │       └── InitialPromptInput
    ├── MonitorMode
    │   ├── LiveCanvasView (React Flow)
    │   │   ├── LiveAgentCard
    │   │   ├── MessageFlowEdge
    │   │   └── AgentActivitySheet
    │   └── GlobalTimeline
    └── MobileTeamView (< 1024px)
        ├── AgentCardStack
        └── VerticalTimeline
```

## State Management (Zustand)

The `TeamCanvasStore` manages the state for the entire feature, adapting the mutable accumulator pattern from `useBrainstormStore`.

```typescript
interface TeamCanvasState {
  // CORE STATE
  mode: 'build' | 'monitor';
  teamName: string;
  nodes: Node[];
  edges: Edge[];

  // BUILD MODE STATE
  selectedNodeId: string | null;
  agentConfigs: {
    [nodeId: string]: {
      agentId: string;
      model: string;
      permissionMode: 'bypass' | 'acceptEdits' | 'default';
      initialPrompt: string;
      assignedTask: string;
    };
  };

  // MONITOR MODE STATE
  liveState: {
    [agentNodeId: string]: {
      status: 'idle' | 'active' | 'awaiting_input' | 'done' | 'error';
      currentActivity: string; // "✏️ Editing: src/index.ts"
      progress: number; // 0-100
      elapsedTime: number;
    };
  };
  timelineEvents: Array<{
    agentId: string;
    timestamp: number;
    type: 'message' | 'tool_call' | 'state_change' | 'error';
    details: any;
  }>;

  // ACTIONS
  setMode: (mode: 'build' | 'monitor') => void;
  addNode: (type: 'agent' | 'task', position: { x: number; y: number }) => void;
  updateNodeConfig: (nodeId: string, config: Partial<AgentConfig>) => void;
  // ... other actions for manipulating nodes, edges, etc.
}
```

## Existing Patterns & Libraries

Based on research findings, the implementation should leverage existing libraries and components:

- **Canvas**: React Flow (`@xyflow/react`) — to be added as a dependency and lazy-loaded via `dynamic()` to `/teams/*` routes.
- **Drag and Drop**: `@dnd-kit/core` with sortable utilities for dragging from the Agent Palette to the Canvas.
- **Grid Layout**: `react-grid-layout` for organizing the Agent Palette.
- **Reusable Components**:
  - `src/components/shared/agent-avatar.tsx` for Agent Avatars.
  - Status indicator pattern from `participant-sidebar.tsx`.
- **Streaming & Real-time**:
  - Monitor Mode requires _N_ concurrent `useSessionStream` instances (one per team member) for rich per-agent data (tool badges, session state rings, token usage).
  - High-volume events (`agent:text-delta`, `agent:thinking-delta`) must be filtered/suppressed at the canvas overview level and only shown in the detailed `AgentActivitySheet`.

## Design System & "Mission Control" Aesthetic

The visual language follows a strict "Mission Control" theme—professional, information-dense, dark-themed, and striking (avoiding generic dashboard styles).

### Color Palette

- **Background**: Deep space dark (`#0a0a0f`) with subtle grid lines or radial gradients (`rgba(15,15,30,1)` to `#0a0a0f`).
- **Panels/Cards**: Translucent dark (`rgba(10, 10, 15, 0.8)`) with backdrop blur (`backdrop-filter: blur(10px)`).
- **Text**: Off-white for primary text (`#d0d0e0`), muted blue-gray for secondary (`#80809a`).
- **Accents (Agent Colors)**:
  - Claude: Purple (`#cda2ff`)
  - Codex: Green (`#a2ffc8`)
  - Gemini: Blue (`#a2d2ff`)
  - Copilot: Orange (`#ffcda2`)
- **Status Indicators**:
  - Active: Neon Green (`#39ff14`) with glow
  - Awaiting Input: Neon Yellow (`#f8ff1f`) with glow
  - Done: Neon Blue (`#00aaff`)
  - Error: Neon Red (`#ff3131`)
  - Idle: Muted Gray (`#80809a`)

### Typography

- **Display Font**: `Orbitron` (sans-serif) for headers, numbers, and primary UI buttons. Gives a technical, terminal-like precision.
- **Body Font**: `Titillium Web` (sans-serif) for dense information, descriptions, and standard UI elements. Highly legible in dark mode.

### Layout & Spacing

- **Grids**: The central canvas uses an explicit visual grid (`rgba(50, 50, 80, 0.4)`) to reinforce the schematic/blueprint feel.
- **Elevation**: Generous drop shadows (`box-shadow: 0 10px 30px rgba(0,0,0,0.5)`) are used to lift nodes and panels above the background grid.
- **Borders**: Sharp, thin borders (`rgba(255, 255, 255, 0.1)`) delineate regions without relying on large blocks of color.

### Motion & Animations

- **Staggered Reveals**: Panels and UI elements fade in softly from bottom to top (`transform: translateY(10px)`) on load.
- **Live Activity (Monitor Mode)**:
  - **Pulsing Dots**: Status indicators use a radial pulse animation (`box-shadow` expansion and fade) to draw attention to active/blocked states.
  - **Message Flow**: SVGs connecting agents use dashed lines (`stroke-dasharray`) with a continuous linear animation (`stroke-dashoffset`) to simulate data/messages flowing along the edge in real-time.
  - **Hover States**: Agent nodes lift slightly (`translateY(-5px)`) and increase shadow intensity to provide immediate interactive feedback.

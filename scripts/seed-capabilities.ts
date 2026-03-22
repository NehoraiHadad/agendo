/**
 * Seed agent_capabilities table with provider-specific capabilities
 * based on the analysis in planning/provider-capability-matrix.md.
 *
 * Run: pnpm tsx scripts/seed-capabilities.ts
 */

import 'dotenv/config';
import { db } from '../src/lib/db';
import { agents, agentCapabilities } from '../src/lib/db/schema';
import { eq } from 'drizzle-orm';

interface CapabilitySeed {
  key: string;
  label: string;
  description: string;
  interactionMode: 'template' | 'prompt';
  supportStatus: 'verified' | 'untested' | 'unsupported';
  providerNotes?: string;
}

// ---------------------------------------------------------------------------
// Capability definitions per provider
// ---------------------------------------------------------------------------

const SHARED_CAPABILITIES: Omit<CapabilitySeed, 'supportStatus' | 'providerNotes'>[] = [
  {
    key: 'mcp_tools',
    label: 'MCP Tools',
    description: 'Can connect to and call MCP server tools (mcp__agendo__* etc.)',
    interactionMode: 'prompt',
  },
  {
    key: 'model_switching',
    label: 'Model Switching',
    description: 'Can change AI model mid-session or at start',
    interactionMode: 'prompt',
  },
  {
    key: 'permission_bypass',
    label: 'Bypass Permissions',
    description: 'Can run in bypassPermissions mode (auto-approve everything)',
    interactionMode: 'prompt',
  },
  {
    key: 'permission_accept_edits',
    label: 'Accept Edits Mode',
    description: 'Can run in acceptEdits mode (auto-approve file changes only)',
    interactionMode: 'prompt',
  },
  {
    key: 'plan_mode',
    label: 'Plan Mode',
    description: 'Can enter/exit plan mode and save plans',
    interactionMode: 'prompt',
  },
  {
    key: 'session_persistence',
    label: 'Session Persistence',
    description: 'Supports multi-turn sessions with resume after idle',
    interactionMode: 'prompt',
  },
  {
    key: 'text_streaming',
    label: 'Text Streaming',
    description: 'Streams text deltas in real-time',
    interactionMode: 'prompt',
  },
  {
    key: 'tool_events',
    label: 'Tool Events',
    description: 'Emits tool-start/tool-end events for visibility',
    interactionMode: 'prompt',
  },
  {
    key: 'bash_terminal',
    label: 'Bash/Terminal',
    description: 'Can execute shell commands',
    interactionMode: 'prompt',
  },
  {
    key: 'custom_commands',
    label: 'Custom Commands/Skills',
    description: 'Supports custom slash commands or skills',
    interactionMode: 'prompt',
  },
  {
    key: 'approval_flow',
    label: 'Approval Flow',
    description: 'Interactive tool approval with allow/deny/allow-session',
    interactionMode: 'prompt',
  },
  {
    key: 'file_checkpointing',
    label: 'File Checkpointing',
    description: 'Can checkpoint and rewind file changes',
    interactionMode: 'prompt',
  },
  {
    key: 'conversation_branching',
    label: 'Conversation Branching',
    description: 'Can fork/rollback conversation history',
    interactionMode: 'prompt',
  },
  {
    key: 'context_compaction',
    label: 'Context Compaction',
    description: 'Auto-compacts context when nearing limits',
    interactionMode: 'prompt',
  },
  {
    key: 'image_attachments',
    label: 'Image Attachments',
    description: 'Can process image attachments in messages',
    interactionMode: 'prompt',
  },
];

const PROVIDER_STATUS: Record<
  string,
  Record<string, { status: 'verified' | 'untested' | 'unsupported'; notes?: string }>
> = {
  claude: {
    mcp_tools: { status: 'verified', notes: 'SDK native via Options.mcpServers' },
    model_switching: { status: 'verified', notes: 'In-place via SDK setModel()' },
    permission_bypass: { status: 'verified' },
    permission_accept_edits: { status: 'verified' },
    plan_mode: { status: 'verified', notes: 'Native ExitPlanMode — gold standard' },
    session_persistence: {
      status: 'verified',
      notes: 'JSONL on disk, fork/resume-at support',
    },
    text_streaming: { status: 'verified', notes: 'stream_event with 200ms batching' },
    tool_events: { status: 'verified' },
    bash_terminal: { status: 'verified' },
    custom_commands: { status: 'verified', notes: '.claude/commands/ markdown files' },
    approval_flow: { status: 'verified', notes: 'canUseTool SDK callback' },
    file_checkpointing: { status: 'verified', notes: 'enableFileCheckpointing + rewindFiles()' },
    conversation_branching: {
      status: 'verified',
      notes: 'forkSession + resumeSessionAt',
    },
    context_compaction: { status: 'verified', notes: 'Auto-compact' },
    image_attachments: { status: 'verified', notes: 'Native base64 image blocks' },
  },
  codex: {
    mcp_tools: { status: 'verified', notes: 'Via config/batchWrite RPC' },
    model_switching: { status: 'verified', notes: 'In-place via setDefaultModel RPC' },
    permission_bypass: {
      status: 'verified',
      notes: 'approvalPolicy=never + sandbox=danger-full-access',
    },
    permission_accept_edits: {
      status: 'verified',
      notes: 'Maps to default (on-request + workspace-write)',
    },
    plan_mode: { status: 'verified', notes: 'read-only sandbox + save_plan MCP' },
    session_persistence: {
      status: 'verified',
      notes: 'thread/resume, thread/fork, thread/rollback',
    },
    text_streaming: { status: 'verified', notes: 'item/outputText/delta' },
    tool_events: { status: 'verified', notes: 'item/tool/start + end' },
    bash_terminal: { status: 'verified', notes: 'Sandboxed execution' },
    custom_commands: {
      status: 'verified',
      notes: 'skills/list RPC + .codex/skills/ filesystem',
    },
    approval_flow: {
      status: 'verified',
      notes: 'requestApproval RPC (accept/acceptForSession/decline/cancel)',
    },
    file_checkpointing: { status: 'unsupported' },
    conversation_branching: { status: 'verified', notes: 'thread/fork + thread/rollback' },
    context_compaction: { status: 'verified', notes: 'thread/compact/start' },
    image_attachments: { status: 'unsupported' },
  },
  gemini: {
    mcp_tools: { status: 'verified', notes: 'ACP mcpServers field + --allowed-mcp-server-names' },
    model_switching: {
      status: 'verified',
      notes: 'Requires process restart (kills and re-spawns)',
    },
    permission_bypass: { status: 'verified', notes: '--approval-mode yolo' },
    permission_accept_edits: { status: 'verified', notes: '--approval-mode auto_edit' },
    plan_mode: {
      status: 'verified',
      notes: '--approval-mode plan + save_plan MCP. Requires experimental.plan in settings.json',
    },
    session_persistence: { status: 'verified', notes: 'ACP session/load' },
    text_streaming: { status: 'verified', notes: 'ACP text-delta events' },
    tool_events: { status: 'verified', notes: 'ACP tool-start/end' },
    bash_terminal: { status: 'verified' },
    custom_commands: { status: 'verified', notes: '.gemini/commands/ TOML files' },
    approval_flow: {
      status: 'verified',
      notes: 'ACP request_permission (nested outcome format)',
    },
    file_checkpointing: { status: 'unsupported' },
    conversation_branching: { status: 'unsupported' },
    context_compaction: { status: 'unsupported' },
    image_attachments: { status: 'verified', notes: 'ACP image parts' },
  },
  copilot: {
    mcp_tools: {
      status: 'verified',
      notes: '--additional-mcp-config flag. Not wired in session-runner.ts yet',
    },
    model_switching: {
      status: 'verified',
      notes: 'unstable_setSessionModel ACP method',
    },
    permission_bypass: { status: 'verified', notes: '--yolo flag' },
    permission_accept_edits: {
      status: 'verified',
      notes: '--allow-all-tools --allow-all-paths',
    },
    plan_mode: {
      status: 'unsupported',
      notes: 'No native plan mode. Uses save_plan MCP fallback only',
    },
    session_persistence: { status: 'verified', notes: '--resume flag' },
    text_streaming: { status: 'verified', notes: 'ACP text-delta events' },
    tool_events: { status: 'verified', notes: 'ACP tool-start/end' },
    bash_terminal: { status: 'verified' },
    custom_commands: { status: 'unsupported' },
    approval_flow: { status: 'verified', notes: 'ACP request_permission' },
    file_checkpointing: { status: 'unsupported' },
    conversation_branching: { status: 'unsupported' },
    context_compaction: { status: 'unsupported' },
    image_attachments: { status: 'verified', notes: 'ACP image parts' },
  },
};

// Map binary name prefix to slug pattern
const BINARY_TO_SLUG: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex-cli',
  gemini: 'gemini-cli',
  copilot: 'github-copilot',
};

async function main() {
  console.log('Seeding agent capabilities...\n');

  // Get all agents
  const allAgents = await db.select().from(agents).where(eq(agents.isActive, true));

  for (const [binaryPrefix, slugPrefix] of Object.entries(BINARY_TO_SLUG)) {
    const agent = allAgents.find((a) => a.slug.startsWith(slugPrefix));
    if (!agent) {
      console.log(`  ⚠ No agent found for ${binaryPrefix} (slug prefix: ${slugPrefix}), skipping`);
      continue;
    }

    const statuses = PROVIDER_STATUS[binaryPrefix];
    if (!statuses) continue;

    let created = 0;
    let skipped = 0;

    for (const cap of SHARED_CAPABILITIES) {
      const providerInfo = statuses[cap.key];
      if (!providerInfo) continue;

      try {
        await db
          .insert(agentCapabilities)
          .values({
            agentId: agent.id,
            key: cap.key,
            label: cap.label,
            description: cap.description,
            source: 'builtin' as const,
            interactionMode: cap.interactionMode,
            supportStatus: providerInfo.status,
            providerNotes: providerInfo.notes ?? null,
            lastTestedAt: new Date(),
          })
          .onConflictDoNothing();
        created++;
      } catch {
        skipped++;
      }
    }

    console.log(
      `  ✓ ${agent.name} (${agent.slug}): ${created} capabilities seeded, ${skipped} skipped`,
    );
  }

  console.log('\nDone!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

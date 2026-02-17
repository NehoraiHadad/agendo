# Phase 2: Agent Auto-Discovery + Registry

> **Goal**: Auto-discover CLI tools via PATH scanning, classify them, extract schemas, present a "Scan & Confirm" UI, and implement full CRUD for agents and capabilities.
> **Prerequisites**: Phase 1 complete -- database migrated, worker running, app shell navigable, all unit tests passing.

---

## Packages to Install

```bash
pnpm add react-hook-form @hookform/resolvers
```

No other new packages required. All discovery logic uses Node.js built-ins (`child_process.execFile`, `fs`, `path`).

---

## Step 1: Discovery Pipeline -- PATH Scanner

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/scanner.ts`

**Purpose**: Scan all directories in `$PATH`, find executable files, deduplicate (first match wins, like `which`), resolve symlinks.

**Inputs**: None (reads `process.env.PATH`)
**Outputs**: `Map<string, ScannedBinary>` where key is binary name

```typescript
import { readdir, stat, access, constants, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ScannedBinary {
  name: string;
  path: string;
  realPath: string;
  isSymlink: boolean;
  dir: string;
}

/**
 * Scan all PATH directories and return a deduplicated map of executables.
 * First match wins (matches `which` behavior).
 * Resolves symlinks via realpath().
 */
export async function scanPATH(): Promise<Map<string, ScannedBinary>> {
  const envPath = process.env.PATH || '';
  const pathDirs = envPath
    .replace(/["]+/g, '')
    .split(path.delimiter)
    .filter(Boolean);

  // Deduplicate PATH dirs (common: /usr/bin and /bin are often the same)
  const uniqueDirs = [...new Set(pathDirs)];

  const binaries = new Map<string, ScannedBinary>();

  for (const dir of uniqueDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (binaries.has(entry.name)) continue; // first match wins

        const fullPath = path.join(dir, entry.name);

        try {
          const stats = await stat(fullPath);
          if (!stats.isFile()) continue;

          await access(fullPath, constants.X_OK);

          let resolvedPath = fullPath;
          let isSymlink = false;
          try {
            resolvedPath = await realpath(fullPath);
            isSymlink = resolvedPath !== fullPath;
          } catch {
            // realpath failed -- use original path
          }

          binaries.set(entry.name, {
            name: entry.name,
            path: fullPath,
            realPath: resolvedPath,
            isSymlink,
            dir,
          });
        } catch {
          // Not executable or stat failed -- skip
        }
      }
    } catch {
      // Directory doesn't exist or not readable -- skip
    }
  }

  return binaries;
}
```

---

## Step 2: Discovery Pipeline -- Binary Identifier

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/identifier.ts`

**Purpose**: Map a binary to its source package, get package metadata, detect file type, extract version.

**Key functions**:
- `identifyBinary(name, binaryPath)` -- returns package name + metadata via `dpkg -S` and `apt-cache show`
- `getFileType(path)` -- runs `file` command to detect ELF/script/symlink
- `getVersion(name)` -- runs `--version`, parses first line

All subprocess calls use `execFile` (not `exec`) to prevent shell injection.

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BinaryIdentity {
  packageName: string | null;
  packageSection: string | null;
  description: string | null;
  fileType: string | null;
  version: string | null;
}

/**
 * Identify a binary: what package owns it, what section, etc.
 */
export async function identifyBinary(
  name: string,
  binaryPath: string,
): Promise<BinaryIdentity> {
  const [packageName, fileType, version] = await Promise.all([
    getPackageName(binaryPath),
    getFileType(binaryPath),
    getVersion(name),
  ]);

  let packageSection: string | null = null;
  let description: string | null = null;

  if (packageName) {
    const metadata = await getPackageMetadata(packageName);
    packageSection = metadata.section;
    description = metadata.description;
  }

  return { packageName, packageSection, description, fileType, version };
}

/**
 * Map binary path to owning package via `dpkg -S`.
 * Returns null if binary is not from a package.
 */
async function getPackageName(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('dpkg', ['-S', binaryPath], {
      timeout: 5000,
    });
    return stdout.split(':')[0].trim();
  } catch {
    return null;
  }
}

/**
 * Get package metadata from apt-cache.
 */
async function getPackageMetadata(
  packageName: string,
): Promise<{ section: string | null; description: string | null }> {
  try {
    const { stdout } = await execFileAsync('apt-cache', ['show', packageName], {
      timeout: 5000,
    });

    const sectionMatch = stdout.match(/^Section:\s*(.+)$/m);
    const descMatch = stdout.match(/^Description(?:-en)?:\s*(.+)$/m);

    return {
      section: sectionMatch ? sectionMatch[1].trim() : null,
      description: descMatch ? descMatch[1].trim() : null,
    };
  } catch {
    return { section: null, description: null };
  }
}

/**
 * Detect file type using the `file` command (ELF, script, symlink).
 */
export async function getFileType(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('file', ['-b', binaryPath], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get version by running `<tool> --version`. Parses first line.
 * Falls back to `-V` and `version` subcommand.
 */
export async function getVersion(name: string): Promise<string | null> {
  for (const args of [['--version'], ['-V'], ['version']]) {
    try {
      const { stdout, stderr } = await execFileAsync(name, args, {
        timeout: 5000,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      });
      const output = stdout || stderr;
      const firstLine = output.split('\n')[0].trim();
      if (firstLine.length > 0 && firstLine.length < 200) {
        return firstLine;
      }
    } catch {
      continue;
    }
  }
  return null;
}
```

---

## Step 3: Discovery Pipeline -- Binary Classifier

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/classifier.ts`

**Purpose**: Classify binaries into categories using man page sections, systemd checks, and name pattern matching.

**Output**: One of `'cli-tool' | 'ai-agent' | 'daemon' | 'interactive-tui' | 'shell-util' | 'admin-tool'`

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ToolType =
  | 'cli-tool'
  | 'ai-agent'
  | 'daemon'
  | 'interactive-tui'
  | 'shell-util'
  | 'admin-tool';

/** Known AI agent binary names */
const AI_AGENT_NAMES = new Set([
  'claude', 'gemini', 'codex', 'cursor-agent', 'openai',
  'aichat', 'ollama', 'grok', 'copilot', 'adk', 'tiny-agents',
]);

/** Known interactive TUI tools */
const TUI_TOOLS = new Set([
  'vim', 'nvim', 'nano', 'emacs', 'htop', 'top', 'btop',
  'tmux', 'screen', 'less', 'more', 'mc',
]);

/** Known shell utilities */
const SHELL_UTILS = new Set([
  'ls', 'cat', 'grep', 'find', 'sort', 'awk', 'sed', 'tr',
  'cut', 'wc', 'head', 'tail', 'cp', 'mv', 'rm', 'mkdir',
  'chmod', 'chown', 'echo', 'printf', 'test', 'true', 'false',
  'env', 'pwd', 'cd', 'basename', 'dirname', 'readlink',
  'tee', 'xargs', 'uniq', 'comm', 'diff', 'patch',
]);

export interface ClassificationInput {
  name: string;
  packageSection: string | null;
}

/**
 * Classify a binary using multiple heuristics.
 */
export async function classifyBinary(
  input: ClassificationInput,
): Promise<ToolType> {
  const { name, packageSection } = input;

  if (AI_AGENT_NAMES.has(name)) return 'ai-agent';
  if (TUI_TOOLS.has(name)) return 'interactive-tui';
  if (SHELL_UTILS.has(name)) return 'shell-util';

  const isService = await isSystemdService(name);
  if (isService) return 'daemon';

  const manSection = await getManSection(name);
  if (manSection === 8) return 'admin-tool';

  if (name.endsWith('d') && name.length > 3) {
    if (packageSection === 'admin' || packageSection === 'net') return 'daemon';
  }

  if (name.includes('ctl')) return 'admin-tool';

  return 'cli-tool';
}

async function getManSection(binaryName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('man', ['-w', binaryName], {
      timeout: 5000,
    });
    const match = stdout.match(/man(\d)\//);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

async function isSystemdService(binaryName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['list-unit-files', '--type=service', '--no-pager'],
      { timeout: 5000 },
    );
    return stdout.toLowerCase().includes(binaryName.toLowerCase());
  } catch {
    return false;
  }
}
```

---

## Step 4: Discovery Pipeline -- Schema Extractor

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/schema-extractor.ts`

**Purpose**: Extract CLI schema (subcommands, flags, positional args) from help text using regex parsing. LLM parse deferred to later phase.

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ParsedOption {
  flags: string[];
  description: string;
  takesValue: boolean;
  valueHint: string | null;
}

export interface ParsedSubcommand {
  name: string;
  description: string;
  aliases: string[];
}

export interface ParsedSchema {
  options: ParsedOption[];
  subcommands: ParsedSubcommand[];
  source: 'help-regex' | 'unknown';
}

/**
 * Get help text from a tool. Uses execFile (no shell) for safety.
 * Tries --help then -h with 5s timeout.
 * Sets TERM=dumb and NO_COLOR=1 to prevent escape sequences.
 */
export async function getHelpText(toolName: string): Promise<string | null> {
  for (const args of [['--help'], ['-h']]) {
    try {
      const { stdout, stderr } = await execFileAsync(toolName, args, {
        timeout: 5000,
        maxBuffer: 1024 * 100,
        env: {
          ...process.env,
          TERM: 'dumb',
          NO_COLOR: '1',
          PAGER: 'cat',
          GIT_PAGER: 'cat',
        },
      });

      const output = stdout || stderr;
      if (output && output.length > 20) return output;
    } catch (err: unknown) {
      const execError = err as { stderr?: string; stdout?: string };
      const output = execError?.stderr || execError?.stdout;
      if (output && output.length > 20) return output;
      continue;
    }
  }
  return null;
}

/**
 * Fast regex-based help text parser.
 * Extracts options (--flags) and subcommands from --help output.
 */
export function quickParseHelp(helpText: string): ParsedSchema {
  const options: ParsedOption[] = [];
  const subcommands: ParsedSubcommand[] = [];

  // Extract options
  const optionRegex =
    /^\s+(--?[\w][\w-]*)(?:[,\s]+(--?[\w][\w-]*))?(?:\s+[<\[]([\w.-]+)[>\]]|\s+([A-Z_]{2,}))?\s{2,}(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = optionRegex.exec(helpText)) !== null) {
    options.push({
      flags: [match[1], match[2]].filter((f): f is string => f !== null),
      description: match[5].trim(),
      takesValue: (match[3] || match[4]) !== undefined,
      valueHint: match[3] || match[4] || null,
    });
  }

  // Extract subcommands
  const cmdRegex = /^\s{2,6}([\w][\w-]*)\s{2,}(.+)$/gm;
  while ((match = cmdRegex.exec(helpText)) !== null) {
    const name = match[1];
    const description = match[2].trim();

    if (name.startsWith('-')) continue;
    if (name.length < 2) continue;
    if (subcommands.some((sc) => sc.name === name)) continue;

    subcommands.push({ name, description, aliases: [] });
  }

  return {
    options,
    subcommands,
    source: options.length > 0 || subcommands.length > 0 ? 'help-regex' : 'unknown',
  };
}
```

---

## Step 5: Discovery Pipeline -- AI Tool Presets

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/presets.ts`

**Purpose**: Hardcoded configurations for known AI tools (Claude, Codex, Gemini). Matched by binary name during discovery. Each preset includes session management config, bidirectional protocol, and default capabilities.

```typescript
import type { AgentSessionConfig, AgentMetadata } from '../types';

export interface AIToolPreset {
  binaryName: string;
  displayName: string;
  kind: 'builtin' as const;
  toolType: 'ai-agent' as const;
  discoveryMethod: 'preset' as const;
  envAllowlist: string[];
  maxConcurrent: number;
  mcpEnabled: boolean;
  sessionConfig: AgentSessionConfig;
  metadata: AgentMetadata;
  defaultCapabilities: PresetCapability[];
}

export interface PresetCapability {
  key: string;
  label: string;
  description: string;
  interactionMode: 'prompt' as const;
  promptTemplate: string;
  dangerLevel: number;
  timeoutSec: number;
}

export const AI_TOOL_PRESETS: Record<string, AIToolPreset> = {
  claude: {
    binaryName: 'claude',
    displayName: 'Claude Code',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK'],
    maxConcurrent: 1,
    mcpEnabled: true,
    sessionConfig: {
      sessionIdSource: 'json_field',
      sessionIdField: 'session_id',
      resumeFlags: ['--resume', '{{sessionRef}}'],
      continueFlags: ['--continue'],
      bidirectionalProtocol: 'stream-json',
    },
    metadata: {
      icon: 'brain',
      color: '#D97706',
      description: 'Anthropic Claude Code CLI -- AI coding assistant',
      homepage: 'https://claude.ai',
    },
    defaultCapabilities: [
      {
        key: 'prompt',
        label: 'Run Prompt',
        description: 'Send a prompt to Claude Code with stream-json bidirectional output',
        interactionMode: 'prompt',
        promptTemplate: '{{task_title}}\n\n{{task_description}}\n\n{{input_context.prompt_additions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
    ],
  },

  codex: {
    binaryName: 'codex',
    displayName: 'Codex CLI',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['OPENAI_API_KEY'],
    maxConcurrent: 1,
    mcpEnabled: true,
    sessionConfig: {
      sessionIdSource: 'filesystem',
      sessionFileGlob: '~/.codex/sessions/**/*.jsonl',
      resumeFlags: ['resume', '{{sessionRef}}'],
      continueFlags: ['resume', '--last'],
      bidirectionalProtocol: 'app-server',
    },
    metadata: {
      icon: 'code',
      color: '#10B981',
      description: 'OpenAI Codex CLI -- AI coding assistant',
      homepage: 'https://openai.com',
    },
    defaultCapabilities: [
      {
        key: 'prompt',
        label: 'Run Prompt',
        description: 'Send a prompt to Codex CLI via app-server JSON-RPC protocol',
        interactionMode: 'prompt',
        promptTemplate: '{{task_title}}\n\n{{task_description}}\n\n{{input_context.prompt_additions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
    ],
  },

  gemini: {
    binaryName: 'gemini',
    displayName: 'Gemini CLI',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    maxConcurrent: 1,
    mcpEnabled: false,
    sessionConfig: {
      sessionIdSource: 'list_command',
      listSessionsCommand: ['gemini', '--list-sessions'],
      listSessionsPattern: '(\\d+)\\.\\s+.+\\[([a-f0-9-]+)\\]',
      resumeFlags: ['--resume', '{{sessionRef}}'],
      continueFlags: ['--resume', 'latest'],
      bidirectionalProtocol: 'tmux',
    },
    metadata: {
      icon: 'sparkles',
      color: '#3B82F6',
      description: 'Google Gemini CLI -- AI coding assistant',
      homepage: 'https://gemini.google.com',
    },
    defaultCapabilities: [
      {
        key: 'prompt',
        label: 'Run Prompt',
        description: 'Send a prompt to Gemini CLI in interactive mode via tmux',
        interactionMode: 'prompt',
        promptTemplate: '{{task_title}}\n\n{{task_description}}\n\n{{input_context.prompt_additions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
    ],
  },
};

/**
 * Look up a preset by binary name.
 */
export function getPresetForBinary(binaryName: string): AIToolPreset | undefined {
  return AI_TOOL_PRESETS[binaryName];
}
```

---

## Step 6: Discovery Pipeline -- Orchestrator

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/index.ts`

**Purpose**: Orchestrates the full discovery pipeline (SCAN -> IDENTIFY -> CLASSIFY -> SCHEMA -> ENRICH -> INDEX). Returns `DiscoveredTool[]` for the UI.

```typescript
import { scanPATH, type ScannedBinary } from './scanner';
import { identifyBinary } from './identifier';
import { classifyBinary, type ToolType } from './classifier';
import { getHelpText, quickParseHelp, type ParsedSchema } from './schema-extractor';
import { getPresetForBinary, type AIToolPreset } from './presets';

export interface DiscoveredTool {
  name: string;
  path: string;
  realPath: string;
  isSymlink: boolean;
  toolType: ToolType;
  version: string | null;
  packageName: string | null;
  packageSection: string | null;
  description: string | null;
  fileType: string | null;
  schema: ParsedSchema | null;
  preset: AIToolPreset | null;
  isConfirmed: boolean;
}

/**
 * Run the full discovery pipeline.
 * Stages 1-3 run for ALL binaries. Stage 4 (schema) runs only for AI presets
 * and optionally for tools in `schemaTargets`.
 */
export async function runDiscovery(
  schemaTargets?: Set<string>,
  existingSlugs?: Set<string>,
): Promise<DiscoveredTool[]> {
  console.log('[discovery] Stage 1: Scanning PATH...');
  const binaries = await scanPATH();
  console.log(`[discovery] Found ${binaries.size} executables.`);

  const tools: DiscoveredTool[] = [];
  const entries = Array.from(binaries.values());
  const BATCH_SIZE = 50;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((binary) => processBinary(binary, schemaTargets, existingSlugs)),
    );
    tools.push(...batchResults);
  }

  // Sort: AI agents first, then by name
  tools.sort((a, b) => {
    const typeOrder: Record<ToolType, number> = {
      'ai-agent': 0, 'cli-tool': 1, 'admin-tool': 2,
      'interactive-tui': 3, 'shell-util': 4, 'daemon': 5,
    };
    const orderDiff = (typeOrder[a.toolType] ?? 9) - (typeOrder[b.toolType] ?? 9);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name);
  });

  return tools;
}

async function processBinary(
  binary: ScannedBinary,
  schemaTargets?: Set<string>,
  existingSlugs?: Set<string>,
): Promise<DiscoveredTool> {
  const identity = await identifyBinary(binary.name, binary.path);
  const toolType = await classifyBinary({
    name: binary.name,
    packageSection: identity.packageSection,
  });
  const preset = getPresetForBinary(binary.name) ?? null;

  let schema: ParsedSchema | null = null;
  const shouldExtractSchema =
    preset !== null ||
    schemaTargets?.has(binary.name) ||
    toolType === 'ai-agent';

  if (shouldExtractSchema) {
    const helpText = await getHelpText(binary.name);
    if (helpText) {
      schema = quickParseHelp(helpText);
    }
  }

  const slug = binary.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  return {
    name: binary.name,
    path: binary.path,
    realPath: binary.realPath,
    isSymlink: binary.isSymlink,
    toolType: preset?.toolType ?? toolType,
    version: identity.version,
    packageName: identity.packageName,
    packageSection: identity.packageSection,
    description: preset?.metadata.description ?? identity.description,
    fileType: identity.fileType,
    schema,
    preset,
    isConfirmed: existingSlugs?.has(slug) ?? false,
  };
}
```

---

## Step 7: Agent Service

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/services/agent-service.ts`

**Purpose**: Business logic for agent CRUD. Validates binary paths via `accessSync`, generates unique slugs, handles bulk creation from discovered tools.

Key functions:
- `createAgent(data)` -- validates binary, generates slug, inserts row
- `createFromDiscovery(tool)` -- creates agent + default capabilities from preset or parsed schema
- `getAgentById(id)`, `listAgents()`, `updateAgent(id, data)`, `deleteAgent(id)` -- standard CRUD
- Binary path validated with `accessSync(path, constants.X_OK)` -- NOT shell execution

See full implementation in the architecture section. The service uses:
- `drizzle-orm` queries for all DB operations
- `ilike` for slug collision detection
- FK cascade handles capability cleanup on delete
- `onConflictDoNothing` not needed (slug is guaranteed unique by generation logic)

---

## Step 8: Capability Service

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/services/capability-service.ts`

**Purpose**: CRUD for agent capabilities. Key validation: template mode requires `commandTokens`, prompt mode allows null.

Key functions:
- `createCapability(data)` -- validates mode/token consistency, inserts row
- `getCapabilitiesByAgent(agentId)`, `getCapabilityById(id)` -- read operations
- `updateCapability(id, data)`, `deleteCapability(id)` -- mutation operations
- `toggleApproval(id)` -- flip the `requiresApproval` flag
- `testCapability(id)` -- runs `--version` on the agent binary to verify it exists

---

## Step 9: Server Actions

**Create** three files:

1. `/home/ubuntu/projects/agent-monitor/src/lib/actions/agent-actions.ts` -- `createAgentAction`, `updateAgentAction`, `deleteAgentAction`
2. `/home/ubuntu/projects/agent-monitor/src/lib/actions/capability-actions.ts` -- `createCapabilityAction`, `updateCapabilityAction`, `deleteCapabilityAction`, `toggleApprovalAction`, `testCapabilityAction`
3. `/home/ubuntu/projects/agent-monitor/src/lib/actions/discovery-actions.ts` -- `triggerScan`, `confirmTool`, `dismissTool`

All server actions follow the `{ success, data?, error? }` return pattern. Each calls `revalidatePath('/agents')` after mutation.

The `triggerScan` action:
1. Fetches existing agent slugs from DB
2. Calls `runDiscovery(undefined, existingSlugs)`
3. Returns the discovered tools list

The `confirmTool` action:
1. Receives a `DiscoveredTool` object
2. Calls `createFromDiscovery(tool)` from agent-service
3. Returns the created agent

---

## Step 10: API Routes -- Agents

**Replace** `/home/ubuntu/projects/agent-monitor/src/app/api/agents/route.ts` -- GET (list all agents), POST (create agent with Zod validation)

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/agents/[id]/route.ts` -- GET, PATCH, DELETE for single agent

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/agents/[id]/capabilities/route.ts` -- GET (list capabilities), POST (create capability)

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/agents/[id]/capabilities/[capId]/route.ts` -- PATCH, DELETE for single capability

All routes use `withErrorBoundary` wrapper. All use `await params` (Next.js 16 async params requirement). POST/PATCH routes validate input with Zod schemas.

Key Zod schemas:
- `createAgentSchema`: `name` (string, 1-100), `binaryPath` (string), `workingDir` (nullable string), `envAllowlist` (string[]), `maxConcurrent` (int, 1-10)
- `createCapSchema`: `key`, `label`, `interactionMode` (enum), `commandTokens` (nullable string[]), `promptTemplate`, `argsSchema`, `dangerLevel` (0-3), `timeoutSec`

---

## Step 11: API Routes -- Discovery

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/discovery/scan/route.ts` -- POST triggers scan, returns `DiscoveredTool[]`

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/discovery/confirm/route.ts` -- POST receives a `DiscoveredTool`, calls `createFromDiscovery`, returns created agent

---

## Step 12: Frontend -- Discovery "Scan & Confirm" Page

**Create** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/agents/discovery/page.tsx` -- renders `DiscoveryScanPage`

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/discovery-scan-page.tsx` (`"use client"`):
- "Scan Now" button triggers `triggerScan()` server action via `useTransition`
- Displays results in a grid of `DiscoveredToolCard` components
- `DiscoveryFilterBar` filters by toolType (All, AI Agents, CLI Tools, etc.)
- Shows counts: total found, unconfirmed
- Empty state when no scan has been run

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/discovered-tool-card.tsx` (`"use client"`):
- Shows tool name, type badge (color-coded), description, version
- "Preset" badge for AI tools with presets
- "Confirmed" badge for already-registered tools
- "Confirm" button calls `confirmTool()`, "Dismiss" button removes from list
- Uses `useTransition` for pending state on confirm

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/discovery-filter-bar.tsx` (`"use client"`):
- Row of filter buttons: All, AI Agents, CLI Tools, Admin Tools, TUI Apps, Daemons, Shell Utils
- Active filter highlighted with `variant="default"`

---

## Step 13: Frontend -- Agent Registry

**Replace** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/agents/page.tsx`:
- RSC page that fetches agents via `agentService.listAgents()`
- "Discover" button links to `/agents/discovery`
- Renders `AgentTable`

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/agent-table.tsx`:
- RSC component rendering a `Table` with columns: Name, Binary Path, Type, Status, Version, Actions
- Empty state message when no agents exist

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/agent-row.tsx` (`"use client"`):
- Expandable row -- click to show/hide capabilities
- ChevronDown/ChevronRight toggle icon
- Edit (pencil icon) and Delete (trash icon) action buttons
- Delete calls `deleteAgentAction` with confirmation dialog

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/agent-status-badge.tsx`:
- Badge showing "Active" (green) or "Inactive" (gray) based on `isActive` field

---

## Step 14: Frontend -- Capability List

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/capability-list.tsx` (`"use client"`):
- Rendered inside expanded agent row
- Fetches capabilities via `apiFetch` on mount
- Shows count in header
- Lists `CapabilityRow` components

**Create** `/home/ubuntu/projects/agent-monitor/src/components/agents/capability-row.tsx` (`"use client"`):
- Shows capability label, interaction mode badge, source badge
- Danger level icon (ShieldCheck=0, Shield=1, ShieldAlert=2, ShieldBan=3) with color coding
- "Disabled" badge when `isEnabled` is false
- Truncated description on the right

---

## Step 15: Frontend -- Basic Schema Form (String + Boolean)

Phase 2 implements string and boolean fields only. Number, enum, array, object fields added in Phase 6.

**Create** `/home/ubuntu/projects/agent-monitor/src/components/forms/schema-form.tsx` (`"use client"`):
- Uses `react-hook-form` with `useForm()`
- Iterates over `schema.properties` and renders `SchemaField` for each
- Checks `schema.required` array for required fields
- Submit button with `isSubmitting` state

**Create** `/home/ubuntu/projects/agent-monitor/src/components/forms/schema-field.tsx`:
- Switch on `schema.type`: renders `SchemaFieldString` or `SchemaFieldBoolean`
- Unsupported types show a "Unsupported field type" message

**Create** `/home/ubuntu/projects/agent-monitor/src/components/forms/schema-field-string.tsx`:
- `<input type="text">` with label, description, required indicator
- Registered with react-hook-form via `register(name, { required })`
- Error message display

**Create** `/home/ubuntu/projects/agent-monitor/src/components/forms/schema-field-boolean.tsx`:
- `<input type="checkbox">` with label and description
- Registered with react-hook-form

---

## Step 16: Unit Tests

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/__tests__/scanner.test.ts`:
- Test: `scanPATH()` returns a Map with size > 0
- Test: deduplication -- binary names appear only once
- Test: symlink resolution -- `isSymlink` and `realPath` fields are populated

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/__tests__/classifier.test.ts`:
- Test: `claude` classified as `ai-agent`
- Test: `gemini` classified as `ai-agent`
- Test: `codex` classified as `ai-agent`
- Test: `vim` classified as `interactive-tui`
- Test: `ls` classified as `shell-util`
- Test: unknown tool defaults to `cli-tool`

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/discovery/__tests__/schema-extractor.test.ts`:
- Test: parses options with short/long flags from help text
- Test: parses subcommands from help text
- Test: `source` is `'unknown'` when no structure found
- Test: options are not misclassified as subcommands

---

## Testing Checklist

| Test | File | What It Verifies |
|------|------|------------------|
| PATH scanning | `discovery/__tests__/scanner.test.ts` | Returns Map, deduplicates, resolves symlinks |
| Binary classification | `discovery/__tests__/classifier.test.ts` | AI agent detection, TUI, shell-util, default fallback |
| Regex help parsing | `discovery/__tests__/schema-extractor.test.ts` | Option and subcommand extraction, empty handling |
| Create from discovery | Manual / integration | Confirm tool -> agent + capabilities created |
| Template cap requires tokens | API test | mode=template + no commandTokens -> 422 |
| Prompt cap allows null tokens | API test | mode=prompt + no commandTokens -> 201 |
| Binary path validation | API test | createAgent with invalid path -> ValidationError |

Run tests:

```bash
pnpm test
```

---

## Verification

When Phase 2 is complete, verify:

1. **Discovery Scan**: Navigate to `/agents/discovery`, click "Scan Now". Should complete in ~20-30 seconds. AI agents appear first with "Preset" badges.

2. **AI Agent Detection**: `claude`, `gemini`, `codex` appear as `ai-agent` type. Presets provide correct descriptions and session configs.

3. **Confirm AI Tool**: Click "Confirm" on Claude. Verify:
   - Agent appears at `/agents` with name "Claude Code", type "ai-agent"
   - Expanding the row shows the "Run Prompt" capability with `interactionMode: prompt`
   - Agent has `sessionConfig` with `bidirectionalProtocol: 'stream-json'`

4. **Confirm CLI Tool**: Confirm `git`. Verify:
   - Agent created with subcommand capabilities (checkout, add, commit, etc.)
   - Each capability has `interactionMode: 'template'` and `commandTokens: ['git', '<subcommand>']`
   - Capabilities are disabled by default (`isEnabled: false`)

5. **Agent CRUD via API**:
   - `GET /api/agents` -- returns list
   - `GET /api/agents/:id` -- returns single agent
   - `PATCH /api/agents/:id` -- updates fields
   - `DELETE /api/agents/:id` -- removes agent, capabilities cascade

6. **Capability Validation**:
   - `POST /api/agents/:id/capabilities` with `interactionMode: 'template'` and no `commandTokens` -> 422
   - `POST /api/agents/:id/capabilities` with `interactionMode: 'prompt'` and no `commandTokens` -> 201

7. **Schema Form**: Manually add a capability with `argsSchema: { type: 'object', properties: { branch: { type: 'string' }, dryRun: { type: 'boolean' } } }`. The form should render a text input for `branch` and a checkbox for `dryRun`.

8. **Filter Bar**: Category filters correctly show/hide tools by type.

9. **Tests**: `pnpm test` passes all unit tests.

10. **Build**: `pnpm build` succeeds.

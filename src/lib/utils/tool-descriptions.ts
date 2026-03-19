/**
 * Human-readable descriptions of tool invocations.
 * Shared between the brainstorm orchestrator (worker), context-extractor,
 * and any UI component that needs to display what an agent is currently doing.
 */

/**
 * Extract the last N segments of a file path.
 * Returns '' for empty/falsy input.
 */
export function shortPath(filePath: string, segments = 2): string {
  if (!filePath) return '';
  return filePath.split('/').slice(-segments).join('/');
}

/**
 * Generate a short, human-readable description of a tool invocation.
 * Returns null for tools that don't produce interesting descriptions.
 *
 * @param toolName - The name of the tool (e.g. "Read", "Grep", "Bash")
 * @param input - The tool's input parameters (optional)
 */
export function describeToolActivity(
  toolName: string,
  input?: Record<string, unknown>,
): string | null {
  if (!toolName) return null;

  const filePath = (input?.file_path ?? input?.path ?? '') as string;
  const short = shortPath(filePath);

  switch (toolName) {
    case 'Read':
      return short ? `Reading ${short}` : 'Reading file';
    case 'Grep':
      return input?.pattern
        ? `Searching for "${String(input.pattern).slice(0, 40)}"`
        : 'Searching code';
    case 'Glob':
      return input?.pattern
        ? `Finding files: ${String(input.pattern).slice(0, 40)}`
        : 'Finding files';
    case 'Bash':
      return 'Running command';
    case 'Agent':
      return input?.description ? String(input.description).slice(0, 60) : 'Running sub-agent';
    case 'Write':
      return short ? `Writing ${short}` : 'Writing file';
    case 'Edit':
      return short ? `Editing ${short}` : 'Editing file';
    default:
      // MCP tools — show a clean short name
      if (toolName.startsWith('mcp__')) {
        const shortName = toolName.replace(/^mcp__\w+__/, '');
        return `Using ${shortName}`;
      }
      return null;
  }
}

/** Extract file_path or path from a tool input record. */
function extractFilePath(input?: Record<string, unknown>): string {
  return String(input?.file_path ?? input?.path ?? '');
}

/**
 * Produce a compact single-line summary of a tool call for inclusion in
 * context transfer prompts. Format: `Edit(path)`, `Bash(\`cmd\`)`, `MCP(tool)`.
 */
export function summarizeToolCall(toolName: string, input?: Record<string, unknown>): string {
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return `Edit(${extractFilePath(input)})`;
  }

  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    const target = extractFilePath(input) || String(input?.pattern ?? input?.glob ?? '');
    return `Read(${target})`;
  }

  if (toolName === 'Bash') {
    const cmd = String(input?.command ?? '').slice(0, 60);
    return `Bash(\`${cmd}\`)`;
  }

  if (toolName.startsWith('mcp__')) {
    return `MCP(${toolName.replace(/^mcp__[^_]+__/, '')})`;
  }

  return toolName;
}

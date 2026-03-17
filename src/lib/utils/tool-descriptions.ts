/**
 * Human-readable descriptions of tool invocations.
 * Shared between the brainstorm orchestrator (worker) and any UI component
 * that needs to display what an agent is currently doing.
 */

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
  const shortPath = filePath ? filePath.split('/').slice(-2).join('/') : '';

  switch (toolName) {
    case 'Read':
      return shortPath ? `Reading ${shortPath}` : 'Reading file';
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
      return shortPath ? `Writing ${shortPath}` : 'Writing file';
    case 'Edit':
      return shortPath ? `Editing ${shortPath}` : 'Editing file';
    default:
      // MCP tools — show a clean short name
      if (toolName.startsWith('mcp__')) {
        const shortName = toolName.replace(/^mcp__\w+__/, '');
        return `Using ${shortName}`;
      }
      return null;
  }
}

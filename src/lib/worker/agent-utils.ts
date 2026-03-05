/**
 * Extracts the binary name from an agent's binaryPath.
 * Equivalent to: agent.binaryPath.split('/').pop()?.toLowerCase() ?? ''
 */
export function getBinaryName(agent: { binaryPath: string }): string {
  return agent.binaryPath.split('/').pop()?.toLowerCase() ?? '';
}

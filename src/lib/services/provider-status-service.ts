import { checkAuthStatus, type AuthStatusResult } from './agent-auth-service';

export interface ProviderStatus extends AuthStatusResult {
  binaryName: string;
}

const CORE_PROVIDERS = ['claude', 'codex', 'gemini', 'copilot'] as const;

/**
 * Returns auth status for all core AI providers.
 * Uses the existing checkAuthStatus() from agent-auth-service.
 */
export function getAllProviderStatuses(): ProviderStatus[] {
  return CORE_PROVIDERS.map((binaryName) => ({
    binaryName,
    ...checkAuthStatus(binaryName),
  }));
}

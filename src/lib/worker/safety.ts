import { realpathSync, accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ValidationError } from '@/lib/errors';
import { allowedWorkingDirs } from '@/lib/config';

export interface SafeEnvOptions {
  base?: string[];
  agentAllowlist?: string[];
}

export interface ValidateArgsOptions {
  schema: Record<string, unknown>;
  args: Record<string, unknown>;
}

const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'] as const;
const SAFE_ARG_PATTERN = /^[a-zA-Z0-9\s/_.,@#:=+-]+$/;

export function validateWorkingDir(workingDir: string): string {
  if (!isAbsolute(workingDir)) {
    throw new ValidationError(`Working directory must be absolute: ${workingDir}`);
  }
  if (!existsSync(workingDir)) {
    throw new ValidationError(`Working directory does not exist: ${workingDir}`);
  }
  const resolved = realpathSync(workingDir);
  const isAllowed = allowedWorkingDirs.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + '/'),
  );
  if (!isAllowed) {
    throw new ValidationError(
      `Working directory not in allowlist: ${resolved}. Allowed: ${allowedWorkingDirs.join(', ')}`,
    );
  }
  return resolved;
}

export function buildChildEnv(opts: SafeEnvOptions = {}): Record<string, string> {
  const allowlist = [...BASE_ENV_ALLOWLIST, ...(opts.agentAllowlist ?? [])];
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export function buildCommandArgs(commandTokens: string[], args: Record<string, unknown>): string[] {
  return commandTokens.map((token) => {
    const match = token.match(/^\{\{(\w+)\}\}$/);
    if (!match) return token;
    const key = match[1];
    const value = args[key];
    if (value === undefined) {
      throw new ValidationError(`Missing required argument: ${key}`);
    }
    if (typeof value === 'object' || Array.isArray(value)) {
      throw new ValidationError(`Object/array values not allowed in command tokens: ${key}`);
    }
    const strValue = String(value);
    if (!SAFE_ARG_PATTERN.test(strValue)) {
      throw new ValidationError(`Argument "${key}" contains disallowed characters: ${strValue}`);
    }
    return strValue;
  });
}

export function validateArgs(
  argsSchema: Record<string, unknown> | null,
  args: Record<string, unknown>,
): void {
  if (!argsSchema) return;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'object' && value !== null) {
      throw new ValidationError(`Argument "${key}" must be a scalar value, got ${typeof value}`);
    }
  }
  const required = (argsSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === '') {
      throw new ValidationError(`Missing required argument: ${key}`);
    }
  }
  const properties = (argsSchema.properties as Record<string, { pattern?: string }>) ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (args[key] !== undefined && propSchema.pattern) {
      const regex = new RegExp(propSchema.pattern);
      if (!regex.test(String(args[key]))) {
        throw new ValidationError(
          `Argument "${key}" does not match pattern: ${propSchema.pattern}`,
        );
      }
    }
  }
}

export function validateBinary(binaryPath: string): void {
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new ValidationError(`Binary not found or not executable: ${binaryPath}`);
  }
}

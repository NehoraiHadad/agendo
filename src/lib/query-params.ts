/**
 * Type-safe helper for reading URL query parameters from a Next.js request.
 * Eliminates repetitive `url.searchParams.get` + manual coercion patterns.
 */
import { NextRequest } from 'next/server';

export class QueryParams {
  private readonly params: URLSearchParams;

  constructor(req: NextRequest) {
    this.params = req.nextUrl.searchParams;
  }

  getString(key: string): string | undefined {
    return this.params.get(key) ?? undefined;
  }

  getNumber(key: string, defaultValue?: number): number | undefined {
    const v = this.params.get(key);
    if (v === null) return defaultValue;
    const n = parseInt(v, 10);
    return isNaN(n) ? defaultValue : n;
  }

  getBoolean(key: string): boolean | undefined {
    const v = this.params.get(key);
    if (v === null) return undefined;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return undefined;
  }

  /** Get a string that must be one of the provided allowed values. */
  getEnum<T extends string>(key: string, values: readonly T[]): T | undefined {
    const v = this.params.get(key);
    if (v === null) return undefined;
    return (values as readonly string[]).includes(v) ? (v as T) : undefined;
  }
}

import { ConflictError } from '@/lib/errors';

type StatusTransitions<S extends string> = Partial<Record<S, S[]>>;

export function createStatusMachine<S extends string>(
  transitions: StatusTransitions<S>,
  label: string,
) {
  return {
    isValid(from: S, to: S): boolean {
      return transitions[from]?.includes(to) ?? false;
    },
    assert(from: S, to: S): void {
      if (!this.isValid(from, to)) {
        throw new ConflictError(`Invalid ${label} status transition: ${from} → ${to}`);
      }
    },
    validTargets(from: S): S[] {
      return transitions[from] ?? [];
    },
  };
}

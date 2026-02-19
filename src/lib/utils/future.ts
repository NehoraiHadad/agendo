/**
 * Future<T> — an externally-resolvable promise.
 *
 * Replaces the raw exitResolve callback pattern in session-process.ts and
 * anywhere else a promise needs to be settled from outside its constructor.
 *
 * Inspired by slopus/happy packages/happy-cli/src/utils/Future.ts
 */
export class Future<T> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T) => void;
  private _reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this._resolve = res;
      this._reject = rej;
    });
  }

  resolve(value: T): void {
    this._resolve(value);
  }

  reject(reason?: unknown): void {
    this._reject(reason);
  }
}

/**
 * Generic NDJSON JSON-RPC 2.0 transport layer.
 *
 * Extracted from CodexAppServerAdapter — handles the low-level send/receive
 * of JSON-RPC messages over stdio (newline-delimited JSON framing).
 *
 * Consumers wire this up by providing:
 *   - getStdin(): returns the writable stdin stream (or null if unavailable)
 *   - onServerRequest(id, method, params): called for server→client requests
 *   - onNotification(method, params): called for server→client notifications
 */

type RpcId = number;
type RpcResult = Record<string, unknown>;

interface PendingRequest {
  resolve: (result: RpcResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface WritableStdin {
  writable: boolean;
  write: (data: string) => void;
}

export interface NdjsonRpcTransportOptions {
  getStdin: () => WritableStdin | null;
  onServerRequest: (id: RpcId, method: string, params: Record<string, unknown>) => void;
  onNotification: (method: string, params: Record<string, unknown>) => void;
}

export class NdjsonRpcTransport {
  private readonly getStdin: () => WritableStdin | null;
  private readonly onServerRequest: NdjsonRpcTransportOptions['onServerRequest'];
  private readonly onNotification: NdjsonRpcTransportOptions['onNotification'];

  private readonly pending = new Map<RpcId, PendingRequest>();
  private nextReqId = 1;

  constructor(opts: NdjsonRpcTransportOptions) {
    this.getStdin = opts.getStdin;
    this.onServerRequest = opts.onServerRequest;
    this.onNotification = opts.onNotification;
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  call(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<RpcResult> {
    const id = this.nextReqId++;
    const stdin = this.getStdin();
    if (!stdin?.writable) {
      return Promise.reject(new Error('stdin not writable'));
    }

    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    stdin.write(msg + '\n');

    return new Promise<RpcResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutHandle });
    });
  }

  /**
   * Send a JSON-RPC response (reply to a server request).
   */
  respond(id: RpcId, result: Record<string, unknown>): void {
    const stdin = this.getStdin();
    if (!stdin?.writable) return;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  /**
   * Send a JSON-RPC notification (no id — no response expected).
   */
  notify(method: string, params: Record<string, unknown>): void {
    const stdin = this.getStdin();
    if (!stdin?.writable) return;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /**
   * Process a single NDJSON line from the server's stdout.
   * Dispatches to pending call resolvers, onServerRequest, or onNotification.
   */
  processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    // JSON-RPC response (id + result/error, no method) → resolve pending call
    if (msg.id != null && !msg.method) {
      const id = msg.id as RpcId;
      const req = this.pending.get(id);
      if (req) {
        clearTimeout(req.timeoutHandle);
        this.pending.delete(id);
        if (msg.error) {
          const errMsg = (msg.error as Record<string, unknown>).message as string;
          req.reject(new Error(errMsg));
        } else {
          req.resolve((msg.result as RpcResult) ?? {});
        }
      }
      return;
    }

    const method = msg.method as string | undefined;
    if (!method) return;

    // Server request (id + method) → approval request or similar
    if (msg.id != null) {
      const id = msg.id as RpcId;
      const params = (msg.params as Record<string, unknown>) ?? {};
      this.onServerRequest(id, method, params);
      return;
    }

    // Notification (method, no id)
    const params = (msg.params as Record<string, unknown>) ?? {};
    this.onNotification(method, params);
  }

  /**
   * Reject all pending requests (e.g. when the process exits).
   */
  rejectAll(reason: string): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timeoutHandle);
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

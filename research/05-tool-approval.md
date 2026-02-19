# Tool Approval Flow

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/utils/permissionHandler.ts (primary), with supporting code from `sdk/query.ts`, `sdk/types.ts`, `claudeRemoteLauncher.ts`, `claudeRemote.ts`, `permissionMode.ts`, `getToolDescriptor.ts`, `docs/permission-resolution.md`, and app-side code in `sources/sync/ops.ts`, `sources/components/tools/PermissionFooter.tsx`

## What

Happy Coder implements a multi-stage tool approval pipeline that intercepts Claude's tool permission requests, relays them to a mobile/web client in real-time, and blocks execution until the user responds. The flow uses Claude Code SDK's `canCallTool` callback mechanism: when Claude wants to use a tool, the SDK emits a `control_request` on stdout, the Happy CLI intercepts it via the `PermissionHandler`, pushes the request to the remote client via Socket.IO agent state + push notifications, then waits for an RPC response before writing a `control_response` back to Claude's stdin. This creates a synchronous approval gate within an asynchronous communication pipeline.

## Problem it solves

In default permission mode, Claude pauses and asks the user before executing tools like file writes, bash commands, or external API calls. When running Claude headlessly (no terminal attached), there is no user to click "approve". The naive solution is to bypass all permissions (`bypassPermissions` mode), but this removes all safety guardrails.

Happy solves this by:
1. **Remoting the approval UI**: Permission prompts appear on the mobile app instead of the terminal
2. **Preserving per-tool granularity**: Users can approve/deny individual tool calls, approve tool categories (e.g., all Bash commands matching a prefix), or switch permission modes entirely
3. **Supporting progressive trust**: "Always allow" responses add tools to an allowlist so future calls auto-approve
4. **Handling plan mode approval**: A special flow for `exit_plan_mode` where approval triggers a fake restart to transition the session from plan mode to execution mode

The key challenge is that Claude's `canCallTool` callback is synchronous from Claude's perspective -- it blocks until a `PermissionResult` is returned. Happy bridges this with a Promise-based pending request system that can wait indefinitely for the remote user to respond.

## How - Source Code

### Step 1: Claude SDK Emits a Control Request

When Claude wants to use a tool in non-bypass mode, the SDK writes a control request to stdout:

```typescript
// packages/happy-cli/src/claude/sdk/types.ts (type definitions)
type CanUseToolControlRequest = {
    type: 'control_request';
    request_id: string;
    request: {
        subtype: 'can_use_tool';
        tool_name: string;
        input: unknown;
    };
};

type PermissionResult =
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string };
```

### Step 2: SDK Query Layer Intercepts the Request

The `Query` class in `sdk/query.ts` reads NDJSON from Claude's stdout and routes control requests to the `canCallTool` callback:

```typescript
// packages/happy-cli/src/claude/sdk/query.ts
private async handleControlRequest(request: CanUseToolControlRequest): Promise<void> {
    if (!this.childStdin) {
        logDebug('Cannot handle control request - no stdin available')
        return
    }

    const controller = new AbortController()
    this.cancelControllers.set(request.request_id, controller)

    try {
        const response = await this.processControlRequest(request, controller.signal)
        const controlResponse: CanUseToolControlResponse = {
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request.request_id,
                response
            }
        }
        this.childStdin.write(JSON.stringify(controlResponse) + '\n')
    } catch (error) {
        const controlErrorResponse: CanUseToolControlResponse = {
            type: 'control_response',
            response: {
                subtype: 'error',
                request_id: request.request_id,
                error: error instanceof Error ? error.message : String(error)
            }
        }
        this.childStdin.write(JSON.stringify(controlErrorResponse) + '\n')
    } finally {
        this.cancelControllers.delete(request.request_id)
    }
}

private async processControlRequest(
    request: CanUseToolControlRequest,
    signal: AbortSignal
): Promise<PermissionResult> {
    if (request.request.subtype === 'can_use_tool') {
        if (!this.canCallTool) {
            throw new Error('canCallTool callback is not provided.')
        }
        return this.canCallTool(request.request.tool_name, request.request.input, {
            signal
        })
    }
    throw new Error('Unsupported control request subtype: ' + request.request.subtype)
}
```

This creates a per-request `AbortController` stored by `request_id`, enabling cancellation if the user aborts. The `canCallTool` callback is the bridge to the PermissionHandler.

### Step 3: PermissionHandler Evaluates and Relays

The `handleToolCall` method first checks allowlists and permission modes before creating a pending request:

```typescript
// packages/happy-cli/src/claude/utils/permissionHandler.ts
handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }): Promise<PermissionResult> => {
    // Check if tool is explicitly allowed
    if (toolName === 'Bash') {
        const inputObj = input as { command?: string };
        if (inputObj?.command) {
            if (this.allowedBashLiterals.has(inputObj.command)) {
                return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
            }
            for (const prefix of this.allowedBashPrefixes) {
                if (inputObj.command.startsWith(prefix)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
            }
        }
    } else if (this.allowedTools.has(toolName)) {
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
    }

    const descriptor = getToolDescriptor(toolName);

    if (this.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
    }

    if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
    }

    let toolCallId = this.resolveToolCallId(toolName, input);
    if (!toolCallId) {
        await delay(1000);
        toolCallId = this.resolveToolCallId(toolName, input);
        if (!toolCallId) {
            throw new Error(`Could not resolve tool call ID for ${toolName}`);
        }
    }
    return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
};
```

Key detail: there is a 1-second retry delay for `resolveToolCallId`. The tool call ID comes from Claude's assistant message (which arrives on the streaming output), while the control request arrives separately. The ID resolution needs to wait for both to arrive.

### Step 4: Push Request to Remote Client

When no local allowlist match is found, `handlePermissionRequest` creates a Promise that blocks until the remote user responds:

```typescript
// packages/happy-cli/src/claude/utils/permissionHandler.ts
private async handlePermissionRequest(
    id: string,
    toolName: string,
    input: unknown,
    signal: AbortSignal
): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
        const abortHandler = () => {
            this.pendingRequests.delete(id);
            reject(new Error('Permission request aborted'));
        };
        signal.addEventListener('abort', abortHandler, { once: true });

        this.pendingRequests.set(id, {
            resolve: (result: PermissionResult) => {
                signal.removeEventListener('abort', abortHandler);
                resolve(result);
            },
            reject: (error: Error) => {
                signal.removeEventListener('abort', abortHandler);
                reject(error);
            },
            toolName,
            input
        });

        if (this.onPermissionRequestCallback) {
            this.onPermissionRequestCallback(id);
        }

        this.session.api.push().sendToAllDevices(
            'Permission Request',
            `Claude wants to ${getToolName(toolName)}`,
            {
                sessionId: this.session.client.sessionId,
                requestId: id,
                tool: toolName,
                type: 'permission_request'
            }
        );

        this.session.client.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now()
                }
            }
        }));
    });
}
```

Three channels are used simultaneously:
1. **Push notification** via `session.api.push().sendToAllDevices()` -- alerts the user even if the app is backgrounded
2. **Agent state update** via `session.client.updateAgentState()` -- adds the request to the `requests` map in the encrypted session state, so the app's UI can render it
3. **Callback** via `onPermissionRequestCallback` -- triggers message queue release in the remote launcher

### Step 5: App-Side Approval UI

The mobile app renders a `PermissionFooter` component with four approval options:

```typescript
// packages/happy-app/sources/components/tools/PermissionFooter.tsx
// Claude sessions render 4 buttons:
// "Yes"                    -> handleApprove()
// "Yes, allow all edits"   -> handleApproveAllEdits()   (edit tools only)
// "Yes for tool"           -> handleApproveForSession()  (non-edit tools only)
// "No, tell Claude"        -> handleDeny()
```

Approval/denial is sent via encrypted RPC:

```typescript
// packages/happy-app/sources/sync/ops.ts
export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session'
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        mode,
        allowTools: allowedTools,
        decision
    };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

export async function sessionDeny(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'denied' | 'abort'
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: false,
        mode,
        allowTools: allowedTools,
        decision
    };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}
```

### Step 6: CLI Receives RPC Response and Resolves Promise

The daemon receives the RPC response and resolves the pending Promise:

```typescript
// packages/happy-cli/src/claude/utils/permissionHandler.ts
private setupClientHandler(): void {
    this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
        const id = message.id;
        const pending = this.pendingRequests.get(id);

        if (!pending) {
            logger.debug('Permission request not found or already resolved');
            return;
        }

        this.responses.set(id, { ...message, receivedAt: Date.now() });
        this.pendingRequests.delete(id);

        this.handlePermissionResponse(message, pending);

        this.session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;
            let r = { ...currentState.requests };
            delete r[id];
            return {
                ...currentState,
                requests: r,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: message.approved ? 'approved' : 'denied',
                        reason: message.reason,
                        mode: message.mode,
                        allowTools: message.allowTools
                    }
                }
            };
        });
    });
}
```

### Step 7: Response Resolution

The response handler resolves the pending Promise, which unblocks the `canCallTool` callback, which writes the `control_response` back to Claude's stdin:

```typescript
// packages/happy-cli/src/claude/utils/permissionHandler.ts
private handlePermissionResponse(
    response: PermissionResponse,
    pending: PendingRequest
): void {
    if (response.allowTools && response.allowTools.length > 0) {
        response.allowTools.forEach(tool => {
            if (tool.startsWith('Bash(') || tool === 'Bash') {
                this.parseBashPermission(tool);
            } else {
                this.allowedTools.add(tool);
            }
        });
    }

    if (response.mode) {
        this.permissionMode = response.mode;
    }

    if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
        if (response.approved) {
            if (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode)) {
                this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: response.mode });
            } else {
                this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'default' });
            }
            pending.resolve({ behavior: 'deny', message: PLAN_FAKE_REJECT });
        } else {
            pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
        }
    } else {
        const result: PermissionResult = response.approved
            ? { behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} }
            : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use.` };
        pending.resolve(result);
    }
}
```

Notable: the `exit_plan_mode` tool always resolves as `deny` even when approved. Approval triggers a `PLAN_FAKE_RESTART` message that restarts Claude with the new permission mode, simulating a mode transition.

### Permission Mode Resolution

Seven modes map to four SDK-supported modes:

```typescript
// packages/happy-cli/src/claude/utils/permissionMode.ts (reconstructed)
function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    // yolo -> bypassPermissions
    // safe-yolo -> default
    // read-only -> default
    // Others pass through: default, acceptEdits, bypassPermissions, plan
}
```

### Tool Descriptor Classification

```typescript
// packages/happy-cli/src/claude/utils/getToolDescriptor.ts
export function getToolDescriptor(toolName: string): { edit: boolean, exitPlan: boolean } {
    if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') {
        return { edit: false, exitPlan: true };
    }
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        return { edit: true, exitPlan: false };
    }
    return { edit: false, exitPlan: false };
}
```

This determines whether `acceptEdits` mode auto-approves a tool (edits only) or whether it requires explicit approval.

## Complete Flow Diagram

```
Claude CLI Process          SDK Query Layer         PermissionHandler         Server          Mobile App
       |                         |                        |                     |                 |
       |-- control_request ----->|                        |                     |                 |
       |   {can_use_tool,        |                        |                     |                 |
       |    tool_name, input}    |                        |                     |                 |
       |                         |-- canCallTool() ------>|                     |                 |
       |                         |   (returns Promise)    |                     |                 |
       |                         |                        |-- check allowlists  |                 |
       |                         |                        |-- check mode        |                 |
       |                         |                        |                     |                 |
       |                         |                        |-- push notification ------------->|
       |                         |                        |-- updateAgentState ->|-- WSS ------->|
       |                         |                        |   {requests: {id}}  |             [User sees
       |                         |                        |                     |              approval UI]
       |                         |                        |                     |             [Taps "Yes"]
       |                         |                        |                     |                 |
       |                         |                        |                     |<-- RPC ---------|
       |                         |                        |<-- RPC relay -------|  'permission'   |
       |                         |                        |   {id, approved}    |                 |
       |                         |                        |                     |                 |
       |                         |                        |-- resolve Promise   |                 |
       |                         |<-- PermissionResult ---|                     |                 |
       |                         |                        |                     |                 |
       |<-- control_response ----|                        |                     |                 |
       |   {success, allow}      |                        |                     |                 |
       |                         |                        |-- updateAgentState  |                 |
       |                         |                        |   {completedReqs} ->|-- WSS -------->|
       |-- tool execution ------>|                        |                     |             [Shows result]
       |-- tool_result (output)->|                        |                     |                 |
```

## Relevance to Agendo

- **What Agendo already does**: Agendo spawns persistent Claude Code CLI processes with `--permission-mode bypassPermissions`, meaning all tool calls are automatically approved. The `ClaudeAdapter` in `claude-adapter.ts` passes this as a hardcoded spawn argument. Agendo already parses `tool_use` and `tool_result` events from Claude's NDJSON output and streams them to the browser via SSE + PG NOTIFY. However, there is no mechanism to intercept and gate tool execution.

- **Gap #1: No tool approval UI**: Agendo has no mechanism for users to approve or deny individual tool calls. This is the biggest gap. Happy's full pipeline (control_request interception -> pending Promise -> remote notification -> RPC response -> control_response) provides a complete blueprint.

- **Gap #2: No progressive trust model**: Happy supports "always allow" responses that add tools to an allowlist (including Bash prefix matching like `Bash(npm test)`), reducing friction over time. Agendo has no concept of per-session or per-user tool allowlists.

- **Gap #3: No permission audit trail**: Happy enriches tool result messages with permission metadata (`{ date, result, mode, allowedTools, decision }`) providing a complete audit trail. Agendo's events include tool-start and tool-end but no approval context.

- **Gap #4: No plan mode support**: Happy handles plan mode approval specially, with the `PLAN_FAKE_RESTART` mechanism. This is a niche feature.

- **Key technical insight for Agendo**: The critical question is whether Claude Code CLI's `--output-format stream-json` mode emits `control_request` events on stdout when in non-bypass permission mode. Happy's SDK layer (`sdk/query.ts`) clearly handles these events. If Agendo switches from `bypassPermissions` to `default` mode, Claude will emit `control_request` events in its NDJSON stream. Agendo's `session-process.ts` would need to detect these in `mapClaudeJsonToEvents()`, emit a `tool:approval-request` event via PG NOTIFY, block further processing until the user responds via a control message, then write a `control_response` back to Claude's stdin.

- **Recommendation**: **Adopt with a phased approach**

  1. **Phase 1 (Low effort, high value): Make permission mode configurable** -- Allow sessions to specify a permission mode (default, acceptEdits, bypassPermissions) instead of hardcoding bypassPermissions. Pass this to the Claude adapter. When in bypassPermissions mode, behavior is unchanged.

  2. **Phase 2 (Medium effort): Interactive approval** -- In `session-process.ts`, detect `control_request` events from Claude's NDJSON output. Emit a `tool:approval-request` AgendoEvent via PG NOTIFY. Add a new control message type `permission-response` that the frontend sends back via the existing control channel. The `onControl` handler resolves a pending Promise, and writes the `control_response` to Claude's stdin. This mirrors Happy's architecture using Agendo's existing PG NOTIFY infrastructure instead of Socket.IO RPC.

  3. **Phase 3 (Low effort): Progressive trust** -- Add an `allowedTools` set to the session model. When users click "Always allow" for a tool, persist it. The approval handler checks this set before creating a pending request. Reuse Happy's Bash prefix-matching pattern (`Bash(command)`) for granular command approval.

  4. **Phase 4 (Low effort): Approval timeout** -- Add a configurable timeout (e.g., 5 minutes) for unanswered permission requests, auto-denying to prevent sessions from hanging indefinitely. Happy does not implement this, leaving sessions blocked until the user responds.

  5. **Skip plan mode**: The `PLAN_FAKE_RESTART` mechanism is clever but complex and not worth adopting unless plan mode is explicitly requested.

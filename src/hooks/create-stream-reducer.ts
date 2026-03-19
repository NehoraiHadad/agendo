'use client';

/**
 * Factory for creating stream reducers with common connection/error/reset actions.
 *
 * Shared across use-session-stream.ts, use-session-log-stream.ts, and
 * use-multi-session-streams.ts to avoid duplicating the same reducer boilerplate.
 */

/** Base state that all stream reducers share. */
export interface BaseStreamState {
  isConnected: boolean;
  error: string | null;
}

/** Common actions handled by the base reducer. */
export type BaseStreamAction =
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' };

/**
 * Creates a reducer that handles SET_CONNECTED, SET_ERROR, and RESET.
 * Custom actions are delegated to the provided `customReducer`.
 *
 * @param initialState  The initial state to return on RESET
 * @param customReducer Handles actions not covered by the base reducer.
 *                      Return `undefined` to signal "not handled" (state unchanged).
 */
export function createStreamReducer<S extends BaseStreamState, A extends { type: string }>(
  initialState: S,
  customReducer: (state: S, action: A) => S | undefined,
): (state: S, action: A | BaseStreamAction) => S {
  return (state: S, action: A | BaseStreamAction): S => {
    switch (action.type) {
      case 'SET_CONNECTED':
        return {
          ...state,
          isConnected: (action as BaseStreamAction & { type: 'SET_CONNECTED' }).connected,
          error: (action as BaseStreamAction & { type: 'SET_CONNECTED' }).connected
            ? null
            : state.error,
        };
      case 'SET_ERROR':
        return {
          ...state,
          error: (action as BaseStreamAction & { type: 'SET_ERROR' }).error,
          isConnected: false,
        };
      case 'RESET':
        return initialState;
      default: {
        const result = customReducer(state, action as A);
        return result !== undefined ? result : state;
      }
    }
  };
}

'use client';

import * as React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDemoMode } from '@/hooks/use-demo-mode';
import {
  DEMO_GUARD_DEFAULT_MESSAGE,
  resolveDemoMessage,
  buildDemoClickHandler,
} from './demo-utils';

export { DEMO_GUARD_DEFAULT_MESSAGE };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DemoGuardProps {
  /**
   * The element to guard. Must be a single React element.
   * The component clones it with aria-disabled + wrapped onClick.
   */
  children?: React.ReactElement;
  /**
   * Render-prop alternative for complex cases where cloneElement doesn't suit.
   * Receives `isDemoBlocked` boolean.
   */
  render?: (isDemoBlocked: boolean) => React.ReactElement;
  /** Override the tooltip message. */
  message?: string;
}

/**
 * Wraps an interactive child element to make it inert in demo mode.
 *
 * In demo mode:
 *   - Clones the child with `aria-disabled="true"` and a no-op click handler.
 *   - Wraps the result in a Tooltip that shows the demo message.
 *
 * In production (non-demo) mode: renders children/render result unchanged.
 *
 * Agent 4B notes:
 * - cloneElement merges props shallowly. The child's existing onClick is NOT
 *   called in demo mode (we replace it via buildDemoClickHandler).
 * - If the child uses onPointerDown or other interaction events, use the
 *   render prop instead, which gives you full control via isDemoBlocked.
 * - The child must be a real DOM element or a component that forwards refs
 *   for TooltipTrigger asChild to work correctly.
 */
export function DemoGuard({ children, render, message }: DemoGuardProps): React.JSX.Element {
  const isDemoBlocked = useDemoMode();

  if (children === undefined && render === undefined) {
    throw new Error('<DemoGuard> requires either children or render prop');
  }

  const tooltipMessage = resolveDemoMessage(message);

  // Resolve the element to render
  let element: React.ReactElement;
  if (render !== undefined) {
    element = render(isDemoBlocked);
  } else {
    const child = children as React.ReactElement<Record<string, unknown>>;
    if (isDemoBlocked) {
      element = React.cloneElement(child, {
        'aria-disabled': 'true',
        tabIndex: child.props.tabIndex ?? 0,
        onClick: buildDemoClickHandler(
          true,
          child.props.onClick as React.MouseEventHandler | undefined,
        ),
      });
    } else {
      element = child;
    }
  }

  if (!isDemoBlocked) {
    return element;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{element}</TooltipTrigger>
        <TooltipContent>{tooltipMessage}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

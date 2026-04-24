/**
 * Tests for DemoGuard pure logic helpers.
 *
 * DOM rendering tests (aria-disabled, tooltip, click handler) require
 * @testing-library/react + jsdom which are not in this project's deps.
 * Those are deferred to Phase 5 E2E tests.
 *
 * Here we test the extracted pure helpers that drive the component logic.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildDemoClickHandler,
  resolveDemoMessage,
  DEMO_GUARD_DEFAULT_MESSAGE,
} from '../demo-utils';
import type React from 'react';

describe('DEMO_GUARD_DEFAULT_MESSAGE', () => {
  it('is the expected fallback message', () => {
    expect(DEMO_GUARD_DEFAULT_MESSAGE).toBe('Not available in demo — install locally to try it.');
  });
});

describe('resolveDemoMessage', () => {
  it('returns the default message when no override is provided', () => {
    expect(resolveDemoMessage(undefined)).toBe(DEMO_GUARD_DEFAULT_MESSAGE);
  });

  it('returns the override message when provided', () => {
    expect(resolveDemoMessage('Custom message')).toBe('Custom message');
  });
});

describe('buildDemoClickHandler', () => {
  it('does not call original handler when demo mode is active', () => {
    const original = vi.fn();
    const handler = buildDemoClickHandler(true, original);
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
    handler(event);
    expect(original).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('calls original handler when demo mode is inactive', () => {
    const original = vi.fn();
    const handler = buildDemoClickHandler(false, original);
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
    handler(event);
    expect(original).toHaveBeenCalledWith(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('is a no-op when no original handler provided and demo is active', () => {
    const handler = buildDemoClickHandler(true, undefined);
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
    expect(() => handler(event)).not.toThrow();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('is a no-op when no original handler provided and demo is inactive', () => {
    const handler = buildDemoClickHandler(false, undefined);
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent;
    expect(() => handler(event)).not.toThrow();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

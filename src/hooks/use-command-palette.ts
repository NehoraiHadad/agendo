'use client';

/**
 * Lightweight event-bus hook for opening the command palette from anywhere in the app.
 * The CommandPalette component listens for these events — no context provider needed.
 */
export function useCommandPalette() {
  function open() {
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('agendo:open-command-palette'));
    }
  }

  function toggle() {
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('agendo:toggle-command-palette'));
    }
  }

  return { open, toggle };
}

import { describe, it, expect, beforeEach } from 'vitest';
import { useGuideStore } from '../guide-store';

describe('useGuideStore', () => {
  beforeEach(() => {
    useGuideStore.setState({ steps: null, stepIndex: 0 });
  });

  it('starts with null steps and index 0', () => {
    const { steps, stepIndex } = useGuideStore.getState();
    expect(steps).toBeNull();
    expect(stepIndex).toBe(0);
  });

  it('setGuide sets steps and resets index', () => {
    useGuideStore.getState().setGuide(['Settings', 'Agents tab']);
    const { steps, stepIndex } = useGuideStore.getState();
    expect(steps).toEqual(['Settings', 'Agents tab']);
    expect(stepIndex).toBe(0);
  });

  it('advanceStep increments index', () => {
    useGuideStore.getState().setGuide(['Sidebar', 'Settings', 'MCP Servers tab']);
    useGuideStore.getState().advanceStep();
    expect(useGuideStore.getState().stepIndex).toBe(1);
    useGuideStore.getState().advanceStep();
    expect(useGuideStore.getState().stepIndex).toBe(2);
  });

  it('advanceStep does not go past last step', () => {
    useGuideStore.getState().setGuide(['A', 'B']);
    useGuideStore.getState().advanceStep();
    useGuideStore.getState().advanceStep(); // already at last
    expect(useGuideStore.getState().stepIndex).toBe(1);
  });

  it('clearGuide resets steps and index', () => {
    useGuideStore.getState().setGuide(['Sidebar', 'Tasks']);
    useGuideStore.getState().advanceStep();
    useGuideStore.getState().clearGuide();
    expect(useGuideStore.getState().steps).toBeNull();
    expect(useGuideStore.getState().stepIndex).toBe(0);
  });

  it('setGuide overwrites previous steps and resets index', () => {
    useGuideStore.getState().setGuide(['A', 'B']);
    useGuideStore.getState().advanceStep();
    useGuideStore.getState().setGuide(['X', 'Y', 'Z']);
    expect(useGuideStore.getState().steps).toEqual(['X', 'Y', 'Z']);
    expect(useGuideStore.getState().stepIndex).toBe(0);
  });
});

import { create } from 'zustand';

interface GuideStore {
  /** All steps from the [GUIDE:] marker */
  steps: string[] | null;
  /** Index of current step being highlighted (advances on route change) */
  stepIndex: number;
  setGuide: (steps: string[]) => void;
  advanceStep: () => void;
  clearGuide: () => void;
}

export const useGuideStore = create<GuideStore>((set, get) => ({
  steps: null,
  stepIndex: 0,
  setGuide: (steps) => set({ steps, stepIndex: 0 }),
  advanceStep: () => {
    const { steps, stepIndex } = get();
    if (steps && stepIndex < steps.length - 1) {
      set({ stepIndex: stepIndex + 1 });
    }
  },
  clearGuide: () => set({ steps: null, stepIndex: 0 }),
}));

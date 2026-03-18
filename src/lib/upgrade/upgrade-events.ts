import type { UpgradeStage } from './upgrade-manager';

export type UpgradeSseEvent =
  | { type: 'log'; line: string }
  | { type: 'stage'; stage: UpgradeStage }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

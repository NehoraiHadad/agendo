/**
 * Smoke test: verifies that representative call-sites across all feature areas
 * have the DemoGuard import wired in. Catches regressions if someone removes guards.
 *
 * This is a source-level test (fs.readFileSync) — not a runtime test. We only check
 * that the import is present; the actual guard behaviour is tested in demo-guard.test.ts.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(process.cwd(), 'src');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const DEMO_IMPORT = /from ['"]@\/components\/demo['"]/;

const GUARDED_FILES: [label: string, path: string][] = [
  // Tasks
  ['task-create-dialog', 'components/tasks/task-create-dialog.tsx'],
  ['task-detail-sheet', 'components/tasks/task-detail-sheet.tsx'],
  // Sessions
  ['session-detail-client', 'app/(dashboard)/sessions/[id]/session-detail-client.tsx'],
  ['session-message-input', 'components/sessions/session-message-input.tsx'],
  ['start-session-dialog', 'components/sessions/start-session-dialog.tsx'],
  // Plans
  ['plan-actions', 'components/plans/plan-actions.tsx'],
  // Brainstorms
  ['create-dialog (brainstorm)', 'components/brainstorms/create-dialog.tsx'],
  ['compose-bar', 'components/brainstorms/compose-bar.tsx'],
  // Projects
  ['project-create-dialog', 'components/projects/project-create-dialog.tsx'],
  ['project-edit-sheet', 'components/projects/project-edit-sheet.tsx'],
  ['deleted-project-card', 'components/projects/deleted-project-card.tsx'],
  // Integrations
  ['integrations-client', 'app/(dashboard)/integrations/integrations-client.tsx'],
  // Agents
  ['refresh-flags-button', 'components/agents/refresh-flags-button.tsx'],
  ['agent-row', 'components/agents/agent-row.tsx'],
];

describe('DemoGuard integration smoke test', () => {
  test.each(GUARDED_FILES)(
    '%s imports from @/components/demo',
    (_label: string, filePath: string) => {
      const content = read(filePath);
      expect(content).toMatch(DEMO_IMPORT);
    },
  );
});

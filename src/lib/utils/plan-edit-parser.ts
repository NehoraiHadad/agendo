import type { AgendoEvent } from '@/lib/realtime/events';

export interface PlanEdit {
  id: string;
  newContent: string;
  eventId: number;
  status: 'pending' | 'applied' | 'skipped';
}

export function extractPlanEdits(events: AgendoEvent[]): PlanEdit[] {
  const edits: PlanEdit[] = [];
  const PLAN_EDIT_RE = /<<<PLAN_EDIT\n([\s\S]*?)\nPLAN_EDIT>>>/g;
  for (const event of events) {
    if (event.type !== 'agent:text') continue;
    PLAN_EDIT_RE.lastIndex = 0;
    let match;
    let idx = 0;
    while ((match = PLAN_EDIT_RE.exec(event.text)) !== null) {
      edits.push({
        id: `${event.id}-${idx++}`,
        newContent: match[1],
        eventId: event.id,
        status: 'pending',
      });
    }
  }
  return edits;
}

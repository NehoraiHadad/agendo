import { describe, it, expect } from 'vitest';
import {
  SYNTHESIS_TEMPLATES,
  DEFAULT_SYNTHESIS_TEMPLATE,
} from '../../worker/synthesis-decision-log';

describe('SYNTHESIS_TEMPLATES', () => {
  it('has templates for all deliverable types', () => {
    expect(SYNTHESIS_TEMPLATES['decision']).toContain('Decision');
    expect(SYNTHESIS_TEMPLATES['options_list']).toContain('Options Evaluated');
    expect(SYNTHESIS_TEMPLATES['action_plan']).toContain('Action Items');
    expect(SYNTHESIS_TEMPLATES['risk_assessment']).toContain('Risks Identified');
    expect(SYNTHESIS_TEMPLATES['exploration']).toContain('Topics Explored');
  });

  it('default template is the decision template', () => {
    expect(DEFAULT_SYNTHESIS_TEMPLATE).toBe(SYNTHESIS_TEMPLATES['decision']);
  });
});

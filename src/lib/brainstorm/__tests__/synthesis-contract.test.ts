import { describe, it, expect } from 'vitest';
import {
  SYNTHESIS_CONTRACTS,
  validateSynthesis,
  type DeliverableType,
} from '../synthesis-contract';

const ALL_DELIVERABLE_TYPES: DeliverableType[] = [
  'decision',
  'options_list',
  'action_plan',
  'risk_assessment',
  'exploration',
];

describe('SYNTHESIS_CONTRACTS', () => {
  it('has a contract for every deliverable type', () => {
    for (const dt of ALL_DELIVERABLE_TYPES) {
      expect(SYNTHESIS_CONTRACTS[dt]).toBeDefined();
      expect(SYNTHESIS_CONTRACTS[dt].deliverableType).toBe(dt);
    }
  });

  it('does not have contracts for unknown types', () => {
    const keys = Object.keys(SYNTHESIS_CONTRACTS);
    for (const key of keys) {
      expect(ALL_DELIVERABLE_TYPES).toContain(key);
    }
  });

  describe('decision contract', () => {
    it('has correct required sections', () => {
      const c = SYNTHESIS_CONTRACTS.decision;
      expect(c.requiredSections).toEqual(['Decision', 'Rationale', 'Next Steps']);
    });

    it('allows task creation from Next Steps', () => {
      const c = SYNTHESIS_CONTRACTS.decision;
      expect(c.allowsTaskCreation).toBe(true);
      expect(c.taskExtractionSection).toBe('Next Steps');
    });

    it('includes Objections Addressed as optional', () => {
      const c = SYNTHESIS_CONTRACTS.decision;
      expect(c.optionalSections).toContain('Objections Addressed');
    });
  });

  describe('options_list contract', () => {
    it('has correct required sections', () => {
      const c = SYNTHESIS_CONTRACTS.options_list;
      expect(c.requiredSections).toEqual(['Options Evaluated', 'Recommendation']);
    });

    it('does not allow task creation', () => {
      const c = SYNTHESIS_CONTRACTS.options_list;
      expect(c.allowsTaskCreation).toBe(false);
      expect(c.taskExtractionSection).toBeNull();
    });
  });

  describe('action_plan contract', () => {
    it('has correct required sections', () => {
      const c = SYNTHESIS_CONTRACTS.action_plan;
      expect(c.requiredSections).toEqual(['Objective', 'Action Items', 'Timeline']);
    });

    it('allows task creation from Action Items', () => {
      const c = SYNTHESIS_CONTRACTS.action_plan;
      expect(c.allowsTaskCreation).toBe(true);
      expect(c.taskExtractionSection).toBe('Action Items');
    });
  });

  describe('risk_assessment contract', () => {
    it('has correct required sections', () => {
      const c = SYNTHESIS_CONTRACTS.risk_assessment;
      expect(c.requiredSections).toEqual(['Risks Identified', 'Recommended Actions']);
    });

    it('allows task creation from Recommended Actions', () => {
      const c = SYNTHESIS_CONTRACTS.risk_assessment;
      expect(c.allowsTaskCreation).toBe(true);
      expect(c.taskExtractionSection).toBe('Recommended Actions');
    });
  });

  describe('exploration contract', () => {
    it('has correct required sections', () => {
      const c = SYNTHESIS_CONTRACTS.exploration;
      expect(c.requiredSections).toEqual(['Key Findings', 'Open Questions']);
    });

    it('does not allow task creation', () => {
      const c = SYNTHESIS_CONTRACTS.exploration;
      expect(c.allowsTaskCreation).toBe(false);
      expect(c.taskExtractionSection).toBeNull();
    });
  });

  describe('all contracts have valid allowedFormats', () => {
    it('every contract has at least one allowed format', () => {
      for (const dt of ALL_DELIVERABLE_TYPES) {
        expect(SYNTHESIS_CONTRACTS[dt].allowedFormats.length).toBeGreaterThan(0);
      }
    });

    it('formats are valid values', () => {
      const validFormats = ['bullet', 'numbered', 'checklist'];
      for (const dt of ALL_DELIVERABLE_TYPES) {
        for (const fmt of SYNTHESIS_CONTRACTS[dt].allowedFormats) {
          expect(validFormats).toContain(fmt);
        }
      }
    });
  });

  describe('taskExtractionSection consistency', () => {
    it('taskExtractionSection is null when allowsTaskCreation is false', () => {
      for (const dt of ALL_DELIVERABLE_TYPES) {
        const c = SYNTHESIS_CONTRACTS[dt];
        if (!c.allowsTaskCreation) {
          expect(c.taskExtractionSection).toBeNull();
        }
      }
    });

    it('taskExtractionSection is non-null when allowsTaskCreation is true', () => {
      for (const dt of ALL_DELIVERABLE_TYPES) {
        const c = SYNTHESIS_CONTRACTS[dt];
        if (c.allowsTaskCreation) {
          expect(c.taskExtractionSection).not.toBeNull();
        }
      }
    });

    it('taskExtractionSection is in requiredSections or optionalSections', () => {
      for (const dt of ALL_DELIVERABLE_TYPES) {
        const c = SYNTHESIS_CONTRACTS[dt];
        if (c.taskExtractionSection) {
          const allSections = [...c.requiredSections, ...c.optionalSections];
          expect(allSections).toContain(c.taskExtractionSection);
        }
      }
    });
  });
});

describe('validateSynthesis', () => {
  it('returns valid for content with all required sections', () => {
    const content = `## Decision
We chose option A.

## Rationale
It was the best choice.

## Next Steps
- [ ] Implement option A`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.decision);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toEqual([]);
  });

  it('returns invalid with missing sections listed', () => {
    const content = `## Decision
We chose option A.`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.decision);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('Rationale');
    expect(result.missingSections).toContain('Next Steps');
  });

  it('does not require optional sections', () => {
    const content = `## Decision
We chose option A.

## Rationale
It was the best.

## Next Steps
- [ ] Do something`;
    // Objections Addressed is optional for decision
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.decision);
    expect(result.valid).toBe(true);
  });

  it('handles sections with varying heading levels correctly (only ## matches)', () => {
    const content = `# Decision
Wrong heading level.

## Rationale
This is correct.

## Next Steps
- [ ] Something`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.decision);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('Decision');
  });

  it('validates action_plan with all required sections', () => {
    const content = `## Objective
Build the thing.

## Action Items
1. [ ] First step — Owner: claude-code-1
2. [ ] Second step — Owner: codex-cli-1

## Timeline
Phase 1: Week 1`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.action_plan);
    expect(result.valid).toBe(true);
  });

  it('validates risk_assessment with all required sections', () => {
    const content = `## Risks Identified
| Risk | Impact | Likelihood | Severity | Mitigation |
|------|--------|-----------|----------|------------|
| Data loss | High | Low | High | Backups |

## Recommended Actions
- [ ] Set up automated backups`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.risk_assessment);
    expect(result.valid).toBe(true);
  });

  it('validates exploration with all required sections', () => {
    const content = `## Key Findings
- Finding 1: evidence
- Finding 2: evidence

## Open Questions
- How does X affect Y?`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.exploration);
    expect(result.valid).toBe(true);
  });

  it('returns found sections in result', () => {
    const content = `## Decision
Done.

## Rationale
Because.

## Objections Addressed
None.

## Next Steps
- [ ] Something`;
    const result = validateSynthesis(content, SYNTHESIS_CONTRACTS.decision);
    expect(result.valid).toBe(true);
    expect(result.foundSections).toContain('Decision');
    expect(result.foundSections).toContain('Rationale');
    expect(result.foundSections).toContain('Objections Addressed');
    expect(result.foundSections).toContain('Next Steps');
  });

  it('handles empty content', () => {
    const result = validateSynthesis('', SYNTHESIS_CONTRACTS.decision);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toEqual(['Decision', 'Rationale', 'Next Steps']);
  });
});

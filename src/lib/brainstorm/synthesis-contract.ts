/**
 * Synthesis contract — defines the authoritative structure for each
 * brainstorm deliverable type. Used by prompt generation, parsing,
 * validation, and task extraction.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliverableType =
  | 'decision'
  | 'options_list'
  | 'action_plan'
  | 'risk_assessment'
  | 'exploration';

export type ListFormat = 'bullet' | 'numbered' | 'checklist';

export interface SynthesisContract {
  deliverableType: DeliverableType;
  requiredSections: string[];
  optionalSections: string[];
  allowsTaskCreation: boolean;
  taskExtractionSection: string | null;
  allowedFormats: ListFormat[];
}

/** Metadata fields that may appear in task extraction lines. */
export interface TaskMetadata {
  owner: string | null;
  due: string | null;
  dependsOn: string | null;
}

export interface ValidationResult {
  valid: boolean;
  missingSections: string[];
  foundSections: string[];
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const SYNTHESIS_CONTRACTS: Record<DeliverableType, SynthesisContract> = {
  decision: {
    deliverableType: 'decision',
    requiredSections: ['Decision', 'Rationale', 'Next Steps'],
    optionalSections: ['Objections Addressed'],
    allowsTaskCreation: true,
    taskExtractionSection: 'Next Steps',
    allowedFormats: ['checklist'],
  },

  options_list: {
    deliverableType: 'options_list',
    requiredSections: ['Options Evaluated', 'Recommendation'],
    optionalSections: ['Open Questions'],
    allowsTaskCreation: false,
    taskExtractionSection: null,
    allowedFormats: ['bullet', 'numbered'],
  },

  action_plan: {
    deliverableType: 'action_plan',
    requiredSections: ['Objective', 'Action Items', 'Timeline'],
    optionalSections: ['Risks & Mitigations'],
    allowsTaskCreation: true,
    taskExtractionSection: 'Action Items',
    allowedFormats: ['numbered', 'checklist'],
  },

  risk_assessment: {
    deliverableType: 'risk_assessment',
    requiredSections: ['Risks Identified', 'Recommended Actions'],
    optionalSections: ['Key Discussion Points'],
    allowsTaskCreation: true,
    taskExtractionSection: 'Recommended Actions',
    allowedFormats: ['checklist', 'bullet'],
  },

  exploration: {
    deliverableType: 'exploration',
    requiredSections: ['Key Findings', 'Open Questions'],
    optionalSections: ['Topics Explored', 'Potential Next Steps'],
    allowsTaskCreation: false,
    taskExtractionSection: null,
    allowedFormats: ['bullet'],
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check that all required sections from the contract are present in the
 * synthesis markdown. Sections are detected as `## Section Name` headings.
 */
export function validateSynthesis(content: string, contract: SynthesisContract): ValidationResult {
  const allSections = [...contract.requiredSections, ...contract.optionalSections];
  const foundSections: string[] = [];

  for (const section of allSections) {
    const pattern = new RegExp(`^## ${escapeRegex(section)}\\s*$`, 'm');
    if (pattern.test(content)) {
      foundSections.push(section);
    }
  }

  const missingSections = contract.requiredSections.filter((s) => !foundSections.includes(s));

  return {
    valid: missingSections.length === 0,
    missingSections,
    foundSections,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import type { PlanAnnotation, AnnotationType } from '@/lib/types/annotations';

const TYPE_LABELS: Record<AnnotationType, string> = {
  comment: 'COMMENT',
  replacement: 'REPLACEMENT',
  deletion: 'DELETION',
  insertion: 'INSERTION',
};

/**
 * Serializes plan annotations into structured markdown feedback for an AI agent.
 *
 * The output is designed to be unambiguous and easy for any LLM to parse:
 * each annotation has a type, location (line numbers), the original text being
 * referenced, the user's comment, and an optional suggested replacement.
 */
export function serializeAnnotations(
  annotations: PlanAnnotation[],
  globalComment?: string,
): string {
  const parts: string[] = [];

  parts.push('# Plan Review Feedback\n');

  if (globalComment?.trim()) {
    parts.push(`## Overall Feedback\n\n${globalComment.trim()}\n`);
    if (annotations.length > 0) parts.push('---\n');
  }

  if (annotations.length > 0) {
    parts.push('## Section Annotations\n');
    annotations.forEach((ann, i) => {
      const locationLabel =
        ann.lineStart === ann.lineEnd
          ? `line ${ann.lineStart}`
          : `lines ${ann.lineStart}–${ann.lineEnd}`;

      parts.push(`### Annotation ${i + 1}: ${TYPE_LABELS[ann.type]} (${locationLabel})\n`);

      parts.push(`**Original text:**\n\`\`\`\n${ann.selectedText}\n\`\`\`\n`);

      parts.push(`**Feedback:** ${ann.comment}\n`);

      if (ann.suggestedText && (ann.type === 'replacement' || ann.type === 'insertion')) {
        const label = ann.type === 'replacement' ? 'Suggested replacement' : 'Content to insert';
        parts.push(`**${label}:**\n\`\`\`\n${ann.suggestedText}\n\`\`\`\n`);
      }

      if (i < annotations.length - 1) parts.push('---\n');
    });
  }

  return parts.join('\n').trim();
}

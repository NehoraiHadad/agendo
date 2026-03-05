import type { AnnotationType } from '@/lib/types/annotations';

/**
 * Visual configuration for a single annotation type.
 * All Tailwind classes are full static strings — no dynamic construction —
 * so Tailwind's scanner includes every class.
 */
export interface AnnotationTypeConfig {
  /** Human-readable label shown in the UI. */
  label: string;
  /** Tailwind class for the 2px left border of annotation cards/highlights. */
  borderLeft: string;
  /** Tailwind class for the card/row background tint. */
  bg: string;
  /** Tailwind class for icon + label text colour. */
  text: string;
  /** Tailwind class for the dot indicator in the gutter. */
  dot: string;
  /** Tailwind class for the badge pill background. */
  badgeBg: string;
  /** Tailwind class for the badge pill text colour. */
  badgeText: string;
  /** Tailwind class for the badge pill border colour. */
  badgeBorder: string;
  /** Whether this type has an optional "suggested text" field. */
  hasSuggested: boolean;
  /** Placeholder for the main comment textarea. */
  placeholder: string;
  /** Placeholder for the suggested-text textarea (only when hasSuggested=true). */
  suggestedPlaceholder?: string;
}

/**
 * Per-type visual config.  Values are copied verbatim from plan-annotator.tsx
 * so both the annotator and future consumers share a single source of truth.
 */
export const ANNOTATION_CONFIGS: Record<AnnotationType, AnnotationTypeConfig> = {
  comment: {
    label: 'Comment',
    borderLeft: 'border-l-sky-400/60',
    bg: 'bg-sky-500/[0.06]',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
    badgeBg: 'bg-sky-500/10',
    badgeText: 'text-sky-400',
    badgeBorder: 'border-sky-500/25',
    hasSuggested: false,
    placeholder: 'What should Claude know about this section?',
  },
  replacement: {
    label: 'Replace',
    borderLeft: 'border-l-amber-400/60',
    bg: 'bg-amber-500/[0.05]',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
    badgeBg: 'bg-amber-500/10',
    badgeText: 'text-amber-400',
    badgeBorder: 'border-amber-500/25',
    hasSuggested: true,
    placeholder: 'Explain what should replace this…',
    suggestedPlaceholder: 'Replacement text (optional)…',
  },
  deletion: {
    label: 'Delete',
    borderLeft: 'border-l-red-400/60',
    bg: 'bg-red-500/[0.05]',
    text: 'text-red-300',
    dot: 'bg-red-400',
    badgeBg: 'bg-red-500/10',
    badgeText: 'text-red-400',
    badgeBorder: 'border-red-500/25',
    hasSuggested: false,
    placeholder: 'Why should this be removed?',
  },
  insertion: {
    label: 'Insert',
    borderLeft: 'border-l-emerald-400/60',
    bg: 'bg-emerald-500/[0.06]',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
    badgeBg: 'bg-emerald-500/10',
    badgeText: 'text-emerald-400',
    badgeBorder: 'border-emerald-500/25',
    hasSuggested: true,
    placeholder: 'Describe the content to insert after this point…',
    suggestedPlaceholder: 'Text to insert (optional)…',
  },
};

/**
 * Canonical display order for annotation types in picker UIs.
 * Exported separately so consumers can iterate without touching the config map.
 */
export const ANNOTATION_TYPE_ORDER: AnnotationType[] = [
  'comment',
  'replacement',
  'deletion',
  'insertion',
];

export type AnnotationType = 'comment' | 'replacement' | 'deletion' | 'insertion';

export interface PlanAnnotation {
  id: string;
  type: AnnotationType;
  /** 1-indexed line number where annotation starts. */
  lineStart: number;
  /** 1-indexed line number where annotation ends (inclusive). */
  lineEnd: number;
  /** The original text being annotated. */
  selectedText: string;
  /** The user's comment or explanation. */
  comment: string;
  /** For 'replacement' and 'insertion': the suggested new/inserted text. */
  suggestedText?: string;
}

/** Selection of one or more markdown blocks in the annotatable preview. */
export interface BlockSelection {
  /** Ordered list of block IDs that are selected (stable IDs from parseMarkdownBlocks). */
  blockIds: string[];
  /** Raw markdown of the selected blocks joined with '\n\n'. Used as selectedText for annotation. */
  selectedText: string;
  /** 1-indexed start line of the first selected block. */
  lineStart: number;
  /** 1-indexed end line of the last selected block. */
  lineEnd: number;
}

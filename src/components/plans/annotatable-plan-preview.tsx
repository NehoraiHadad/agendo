'use client';

import { useMemo, useCallback } from 'react';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { parseMarkdownBlocks } from '@/lib/utils/markdown-blocks';
import { ANNOTATION_CONFIGS } from '@/lib/utils/annotation-configs';
import type { PlanAnnotation, BlockSelection } from '@/lib/types/annotations';
import type { MarkdownBlock } from '@/lib/utils/markdown-blocks';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AnnotatablePlanPreviewProps {
  content: string;
  annotations: PlanAnnotation[];
  selection: BlockSelection | null;
  onSelectionChange: (sel: BlockSelection | null) => void;
  /** When false: renders as a normal (non-interactive) preview. */
  annotationMode: boolean;
}

// ---------------------------------------------------------------------------
// Shared ReactMarkdown component renderers
// Copied verbatim from PlanMarkdownPreview in plan-detail-client.tsx so the
// prose styles are identical in both annotation mode and normal preview.
// ---------------------------------------------------------------------------

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ children }) => (
    <h1 className="text-lg font-bold text-foreground/90 border-b border-white/[0.06] pb-2 mb-4 mt-6 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold text-foreground/85 mt-5 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-foreground/80 mt-4 mb-1.5">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-sm text-foreground/70 leading-relaxed mb-3">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-1 mb-3 text-sm text-foreground/70 pl-2">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-1 mb-3 text-sm text-foreground/70 pl-2">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="text-sm text-foreground/70">{children}</li>,
  code: ({ className, children, ...rest }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="font-mono text-xs bg-white/[0.07] text-primary/80 rounded px-1.5 py-0.5">
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          'block font-mono text-xs bg-[oklch(0.08_0_0)] text-foreground/75 rounded-lg p-3 overflow-x-auto whitespace-pre',
          className,
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3 rounded-lg overflow-hidden border border-white/[0.06]">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/30 pl-3 my-3 text-sm text-muted-foreground/60 italic">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground/90">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-foreground/70">{children}</em>,
  hr: () => <hr className="border-white/[0.06] my-4" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary/80 hover:text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
};

// ---------------------------------------------------------------------------
// Gutter dot stack
// ---------------------------------------------------------------------------

interface GutterDotsProps {
  blockAnnotations: PlanAnnotation[];
}

function GutterDots({ blockAnnotations }: GutterDotsProps) {
  if (blockAnnotations.length === 0) return null;

  const visible = blockAnnotations.slice(0, 3);
  const overflow = blockAnnotations.length - 3;

  return (
    <div className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-[3px] w-3">
      {visible.map((ann) => {
        const cfg = ANNOTATION_CONFIGS[ann.type];
        return (
          <span
            key={ann.id}
            className={cn('inline-block size-1.5 rounded-full shrink-0', cfg.dot)}
            aria-hidden="true"
          />
        );
      })}
      {overflow > 0 && (
        <span className="text-[8px] leading-none text-muted-foreground/50">+{overflow}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block wrapper — applies visual states and interaction
// ---------------------------------------------------------------------------

interface BlockWrapperProps {
  block: MarkdownBlock;
  blockAnnotations: PlanAnnotation[];
  isSelected: boolean;
  annotationMode: boolean;
  onClick: (blockId: string, shiftKey: boolean) => void;
  children: React.ReactNode;
}

function BlockWrapper({
  block,
  blockAnnotations,
  isSelected,
  annotationMode,
  onClick,
  children: _children,
}: BlockWrapperProps) {
  const hasAnnotations = blockAnnotations.length > 0;

  // The first annotation's type drives the color when annotated (and not selected).
  const firstAnnotationType = blockAnnotations[0]?.type;

  // Build the class string using only full static strings — no dynamic template literals.
  // Selected state takes visual priority over annotated state.
  function borderAndBgClass(): string {
    if (isSelected) {
      return 'border-l-2 border-l-amber-400/70 bg-amber-500/[0.08]';
    }
    if (hasAnnotations) {
      switch (firstAnnotationType) {
        case 'comment':
          return 'border-l-2 border-l-sky-400/50 bg-sky-500/[0.06]';
        case 'replacement':
          return 'border-l-2 border-l-amber-400/50 bg-amber-500/[0.05]';
        case 'deletion':
          return 'border-l-2 border-l-red-400/50 bg-red-500/[0.05]';
        case 'insertion':
          return 'border-l-2 border-l-emerald-400/50 bg-emerald-500/[0.06]';
        default:
          return 'border-l-2 border-l-white/10';
      }
    }
    if (annotationMode) {
      return 'border-l-2 border-l-white/10 hover:bg-white/[0.02]';
    }
    return 'border-l-2 border-l-transparent';
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!annotationMode) return;
      onClick(block.id, e.shiftKey);
    },
    [annotationMode, block.id, onClick],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!annotationMode) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(block.id, false);
      }
    },
    [annotationMode, block.id, onClick],
  );

  // Extra top margin for top-level headings to match PlanMarkdownPreview prose spacing.
  const headingMargin = block.type === 'h1' ? 'mt-6 first:mt-0' : block.type === 'h2' ? 'mt-5' : '';

  return (
    <div
      id={`annotatable-block-${block.id}`}
      role={annotationMode ? 'button' : undefined}
      tabIndex={annotationMode ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative pl-4 pr-2 rounded-sm transition-colors duration-100 outline-none',
        // Mobile touch target
        'min-h-[44px] sm:min-h-0',
        // Annotation mode pointer
        annotationMode && 'cursor-pointer',
        // Focus-visible ring for keyboard navigation
        annotationMode &&
          'focus-visible:ring-1 focus-visible:ring-amber-400/40 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
        headingMargin,
        borderAndBgClass(),
      )}
    >
      {/* Gutter dots — only for annotated (not selected) blocks */}
      {hasAnnotations && !isSelected && <GutterDots blockAnnotations={blockAnnotations} />}

      {/* Block content — rendered via ReactMarkdown */}
      <div className="prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
          {block.raw}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Annotation mode header bar
// ---------------------------------------------------------------------------

function AnnotationModeBar() {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-amber-500/[0.06] border-b border-amber-500/15 shrink-0">
      <span className="inline-block size-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
      <p className="text-[11px] text-amber-300/80 leading-tight">
        Annotation mode &mdash; tap a section to annotate &middot; Shift+tap for range
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AnnotatablePlanPreview
// ---------------------------------------------------------------------------

export function AnnotatablePlanPreview({
  content,
  annotations,
  selection,
  onSelectionChange,
  annotationMode,
}: AnnotatablePlanPreviewProps): React.JSX.Element {
  // 1. Parse content into blocks (stable across re-renders when content unchanged)
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  // 2. Build blockId → PlanAnnotation[] map
  const blockAnnotationsMap = useMemo(() => {
    const map = new Map<string, PlanAnnotation[]>();
    for (const block of blocks) {
      map.set(block.id, []);
    }
    for (const ann of annotations) {
      // An annotation belongs to a block when their line ranges overlap.
      for (const block of blocks) {
        if (ann.lineStart <= block.lineEnd && ann.lineEnd >= block.lineStart) {
          const existing = map.get(block.id);
          if (existing !== undefined) {
            existing.push(ann);
          }
        }
      }
    }
    return map;
  }, [blocks, annotations]);

  // 3. Build a Set of selected block IDs for O(1) lookup
  const selectedBlockIds = useMemo(() => new Set(selection?.blockIds ?? []), [selection]);

  // 4. Click handler
  const handleBlockClick = useCallback(
    (blockId: string, shiftKey: boolean) => {
      if (!annotationMode) return;

      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;

      if (!shiftKey || !selection) {
        // Toggle single selection
        if (
          selection !== null &&
          selection.blockIds.length === 1 &&
          selection.blockIds[0] === blockId
        ) {
          onSelectionChange(null); // deselect
          return;
        }
        onSelectionChange({
          blockIds: [blockId],
          selectedText: block.raw,
          lineStart: block.lineStart,
          lineEnd: block.lineEnd,
        });
      } else {
        // Extend to range from first selected block to this block
        const firstId = selection.blockIds[0];
        if (firstId === undefined) return;

        const firstIdx = blocks.findIndex((b) => b.id === firstId);
        const thisIdx = blocks.findIndex((b) => b.id === blockId);
        if (firstIdx === -1 || thisIdx === -1) return;

        const lo = firstIdx <= thisIdx ? firstIdx : thisIdx;
        const hi = firstIdx <= thisIdx ? thisIdx : firstIdx;
        const range: MarkdownBlock[] = blocks.slice(lo, hi + 1);

        onSelectionChange({
          blockIds: range.map((b) => b.id),
          selectedText: range.map((b) => b.raw).join('\n\n'),
          lineStart: range[0]?.lineStart ?? block.lineStart,
          lineEnd: range[range.length - 1]?.lineEnd ?? block.lineEnd,
        });
      }
    },
    [annotationMode, blocks, selection, onSelectionChange],
  );

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  if (!content.trim()) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground/30 italic">Nothing to preview yet.</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Sticky annotation mode bar */}
      {annotationMode && <AnnotationModeBar />}

      {/* Block list */}
      <div className="flex-1 overflow-y-auto px-2 py-4 space-y-0.5">
        {blocks.map((block) => {
          const blockAnnotations = blockAnnotationsMap.get(block.id) ?? [];
          const isSelected = selectedBlockIds.has(block.id);

          return (
            <BlockWrapper
              key={block.id}
              block={block}
              blockAnnotations={blockAnnotations}
              isSelected={isSelected}
              annotationMode={annotationMode}
              onClick={handleBlockClick}
            >
              {/* children prop is required by interface but content is rendered inside wrapper */}
              {null}
            </BlockWrapper>
          );
        })}
      </div>
    </div>
  );
}

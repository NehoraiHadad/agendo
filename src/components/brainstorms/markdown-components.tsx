import type { Components } from 'react-markdown';

// ============================================================================
// Shared markdown component configs for brainstorm views
// ============================================================================

/**
 * Markdown components for agent message cards in the brainstorm room.
 * Used by MessageCard (AgentMessageCard).
 */
export const brainstormMdComponents: Components = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p dir="auto" className="mb-1.5 last:mb-0 leading-relaxed">
      {children}
    </p>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <code className="block bg-black/20 rounded-md px-3 py-2 text-[11px] font-mono overflow-x-auto whitespace-pre my-2 border border-white/[0.06]">
        {children}
      </code>
    ) : (
      <code className="bg-black/20 rounded px-1 py-px text-[11px] font-mono border border-white/[0.06]">
        {children}
      </code>
    );
  },
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul dir="auto" className="list-disc ps-4 mb-1.5 space-y-0.5">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol dir="auto" className="list-decimal ps-4 mb-1.5 space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li dir="auto" className="text-foreground/70 leading-relaxed">
      {children}
    </li>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 dir="auto" className="text-sm font-semibold text-foreground/90 mb-1 mt-3 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 dir="auto" className="text-xs font-semibold text-foreground/80 mb-1 mt-2.5 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 dir="auto" className="text-xs font-medium text-foreground/75 mb-1 mt-2 first:mt-0">
      {children}
    </h3>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote
      dir="auto"
      className="border-s-2 border-white/20 ps-3 text-foreground/55 italic my-1.5"
    >
      {children}
    </blockquote>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground/85">{children}</strong>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary/70 underline underline-offset-2 hover:text-primary/90 transition-colors"
    >
      {children}
    </a>
  ),
};

/**
 * Markdown components for the synthesis panel in the brainstorm room.
 * Slightly looser spacing and violet-tinted blockquotes to match the synthesis panel styling.
 * Used by SynthesisPanel (room-view.tsx).
 */
export const synthesisMdComponents: Components = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p dir="auto" className="mb-2 last:mb-0 leading-relaxed">
      {children}
    </p>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 dir="auto" className="text-sm font-semibold text-foreground/90 mb-2 mt-4 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 dir="auto" className="text-xs font-semibold text-foreground/80 mb-1.5 mt-3 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 dir="auto" className="text-xs font-medium text-foreground/75 mb-1 mt-2 first:mt-0">
      {children}
    </h3>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul dir="auto" className="list-disc ps-4 mb-2 space-y-0.5">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol dir="auto" className="list-decimal ps-4 mb-2 space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li dir="auto" className="text-foreground/70 leading-relaxed">
      {children}
    </li>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <code className="block bg-black/20 rounded-md px-3 py-2 text-[11px] font-mono overflow-x-auto whitespace-pre my-2 border border-white/[0.06]">
        {children}
      </code>
    ) : (
      <code className="bg-black/20 rounded px-1 py-px text-[11px] font-mono border border-white/[0.06]">
        {children}
      </code>
    );
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote
      dir="auto"
      className="border-s-2 border-violet-500/30 ps-3 text-foreground/65 italic my-2"
    >
      {children}
    </blockquote>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground/85">{children}</strong>
  ),
};

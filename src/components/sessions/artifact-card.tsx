'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ExternalLink, Maximize2, Minimize2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Agent theming
// ---------------------------------------------------------------------------

type AgentVariant = 'claude' | 'codex' | 'gemini' | 'copilot' | 'default';

function resolveVariant(slug?: string): AgentVariant {
  if (!slug) return 'default';
  const s = slug.toLowerCase();
  if (s.startsWith('claude')) return 'claude';
  if (s.startsWith('codex')) return 'codex';
  if (s.startsWith('gemini')) return 'gemini';
  if (s.startsWith('copilot') || s.includes('copilot')) return 'copilot';
  return 'default';
}

/** Two stop colors for the agent-tinted shimmer gradient. */
const SHIMMER_COLORS: Record<AgentVariant, [string, string]> = {
  claude: ['oklch(0.6 0.25 290 / 0)', 'oklch(0.6 0.25 290 / 0.12)'],
  codex: ['oklch(0.75 0.17 160 / 0)', 'oklch(0.75 0.17 160 / 0.12)'],
  gemini: ['oklch(0.65 0.2 250 / 0)', 'oklch(0.65 0.2 250 / 0.12)'],
  copilot: ['oklch(0.6 0.2 270 / 0)', 'oklch(0.6 0.2 270 / 0.12)'],
  default: ['oklch(1 0 0 / 0)', 'oklch(1 0 0 / 0.06)'],
};

const VARIANTS: Record<
  AgentVariant,
  { label: string | null; dot: string; borderL: string; headerBg: string; accentText: string }
> = {
  claude: {
    label: 'Claude',
    dot: 'bg-violet-500',
    borderL: 'border-l-violet-500',
    headerBg: 'bg-violet-500/[0.07]',
    accentText: 'text-violet-400',
  },
  codex: {
    label: 'Codex',
    dot: 'bg-emerald-500',
    borderL: 'border-l-emerald-500',
    headerBg: 'bg-emerald-500/[0.07]',
    accentText: 'text-emerald-400',
  },
  gemini: {
    label: 'Gemini',
    dot: 'bg-blue-500',
    borderL: 'border-l-blue-500',
    headerBg: 'bg-blue-500/[0.07]',
    accentText: 'text-blue-400',
  },
  copilot: {
    label: 'Copilot',
    dot: 'bg-indigo-400',
    borderL: 'border-l-indigo-400',
    headerBg: 'bg-indigo-500/[0.07]',
    accentText: 'text-indigo-400',
  },
  default: {
    label: null,
    dot: 'bg-zinc-500',
    borderL: 'border-l-zinc-600',
    headerBg: 'bg-white/[0.03]',
    accentText: 'text-zinc-400',
  },
};

// ---------------------------------------------------------------------------
// Artifact type icon
// ---------------------------------------------------------------------------

function ArtifactTypeIcon({ type, className }: { type?: 'html' | 'svg'; className?: string }) {
  if (type === 'svg') {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cn('h-3.5 w-3.5 shrink-0', className)}>
        <circle cx="5" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
        <rect
          x="8.5"
          y="8.5"
          width="5"
          height="5"
          rx="0.8"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path d="M2 14.5L6.5 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn('h-3.5 w-3.5 shrink-0', className)}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.5 6L3.5 8L5.5 10M10.5 6L12.5 8L10.5 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ArtifactCardProps {
  artifactId?: string;
  title: string;
  artifactType?: 'html' | 'svg';
  /** Raw tool result content from agent:tool-end (JSON string of artifact object) */
  toolResultText?: string;
  /** Agent slug (e.g. 'claude-code-1') — drives the accent color theme */
  agentSlug?: string;
  /** True while the tool is still executing — shows an animated skeleton */
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ArtifactCard({
  artifactId,
  title,
  artifactType = 'html',
  toolResultText,
  agentSlug,
  isLoading = false,
}: ArtifactCardProps) {
  const v = VARIANTS[resolveVariant(agentSlug)];
  const [shimmerFade0, shimmerFade50] = SHIMMER_COLORS[resolveVariant(agentSlug)];

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Track native fullscreen state
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!iframeRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await iframeRef.current.requestFullscreen();
    }
  }, []);

  const shimmerStyle: React.CSSProperties = {
    background: `linear-gradient(90deg, ${shimmerFade0} 0%, ${shimmerFade50} 50%, ${shimmerFade0} 100%)`,
    backgroundSize: '200% 100%',
  };

  const setupBridge = useCallback(() => {
    if (!iframeRef.current?.contentWindow || !toolResultText) return;
    setIframeReady(true);

    const bridge = new AppBridge(null, { name: 'Agendo', version: '1.0.0' }, {});

    bridge.oninitialized = () => {
      bridge
        .sendToolResult({
          content: [{ type: 'text', text: toolResultText }],
        })
        .catch(console.error);
    };

    bridge.oncalltool = async (params) => {
      const resp = await fetch('/api/mcp-apps/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return resp.json() as Promise<CallToolResult>;
    };

    const transport = new PostMessageTransport(
      iframeRef.current.contentWindow,
      iframeRef.current.contentWindow,
    );
    bridge.connect(transport).catch(console.error);
    bridgeRef.current = bridge;
  }, [toolResultText]);

  useEffect(() => {
    return () => {
      bridgeRef.current?.teardownResource({}).catch(() => {});
    };
  }, []);

  const viewerUrl = artifactId
    ? `/mcp-app?artifactId=${encodeURIComponent(artifactId)}&title=${encodeURIComponent(title)}&type=${artifactType}`
    : null;

  // Shared header JSX (inlined to avoid react-hooks/static-components violation)
  const headerJsx = (shimmerTitle: boolean) => (
    <div
      className={cn('flex items-center gap-2 px-3 py-2 border-b border-white/[0.06]', v.headerBg)}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full shrink-0', v.dot, shimmerTitle && 'animate-pulse')}
      />
      {v.label && (
        <span
          className={cn(
            'text-[10px] font-mono font-semibold uppercase tracking-widest opacity-50',
            v.accentText,
          )}
        >
          {v.label}
        </span>
      )}
      {v.label && <span className="text-white/[0.12] text-xs select-none shrink-0">·</span>}
      <ArtifactTypeIcon type={artifactType} className={cn('opacity-45', v.accentText)} />
      {shimmerTitle ? (
        <div className="h-2.5 rounded flex-1 max-w-[150px] animate-shimmer" style={shimmerStyle} />
      ) : (
        <span className="text-[13px] font-medium text-foreground/80 flex-1 truncate min-w-0">
          {title}
        </span>
      )}
      {!shimmerTitle && (
        <div className="flex items-center gap-0.5 shrink-0 ml-1">
          <button
            type="button"
            onClick={() => {
              void toggleFullscreen();
            }}
            className="p-1 rounded hover:bg-white/[0.07] text-white/25 hover:text-white/55 transition-colors"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
          {viewerUrl && (
            <a
              href={viewerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 rounded hover:bg-white/[0.07] text-white/25 hover:text-white/55 transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Loading skeleton
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div
        className={cn(
          'my-3 rounded-lg border border-white/[0.07] overflow-hidden border-l-2',
          v.borderL,
        )}
      >
        {headerJsx(true)}
        <div className="relative overflow-hidden" style={{ height: 180 }}>
          <div className="absolute inset-0 bg-[oklch(0.075_0_0)]" />
          <div className="absolute inset-0 animate-shimmer" style={shimmerStyle} />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
            <Loader2 className={cn('h-5 w-5 animate-spin opacity-30', v.accentText)} />
            <span className="text-[11px] text-white/20 font-mono tracking-wider">generating…</span>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Loaded artifact
  // ---------------------------------------------------------------------------

  return (
    <div
      className={cn(
        'my-3 rounded-lg border border-white/[0.07] overflow-hidden border-l-2',
        v.borderL,
      )}
    >
      {headerJsx(false)}

      <div className="relative" style={{ height: 420 }}>
        {/* Spinner overlay until iframe signals ready */}
        {!iframeReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-[oklch(0.075_0_0)] z-10">
            <Loader2 className={cn('h-5 w-5 animate-spin opacity-25', v.accentText)} />
          </div>
        )}

        {viewerUrl && (
          <iframe
            ref={iframeRef}
            src={viewerUrl}
            sandbox="allow-scripts allow-same-origin allow-forms allow-fullscreen"
            allow="fullscreen"
            allowFullScreen
            className={cn(
              'w-full h-full border-0 transition-opacity duration-300',
              iframeReady ? 'opacity-100' : 'opacity-0',
            )}
            title={title}
            onLoad={setupBridge}
          />
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiDisplayMode,
  type McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge';
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
// Host context helpers
// ---------------------------------------------------------------------------

/**
 * Build the initial McpUiHostContext for a new bridge connection.
 * Sends agendo's dark theme CSS variables, display mode, and container
 * dimensions to the artifact app so it can adapt its styling.
 */
function buildHostContext(opts: {
  displayMode: McpUiDisplayMode;
  containerWidth: number;
  containerHeight: number;
}): McpUiHostContext {
  return {
    theme: 'dark',
    platform: 'web',
    displayMode: opts.displayMode,
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width: opts.containerWidth, height: opts.containerHeight },
    // Agendo dark theme CSS variables — allow artifacts to match the host UI.
    // Cast as McpUiStyles: the type requires all keys but treats absent ones as
    // undefined, which is valid at runtime per the Record<Key, string|undefined> spec.
    styles: {
      variables: {
        '--color-background-primary': 'oklch(0.075 0 0)',
        '--color-background-secondary': 'oklch(0.11 0 0)',
        '--color-background-tertiary': 'oklch(0.14 0 0)',
        '--color-text-primary': 'oklch(0.93 0 0)',
        '--color-text-secondary': 'oklch(0.65 0 0)',
        '--color-text-tertiary': 'oklch(0.45 0 0)',
        '--color-border-primary': 'oklch(0.93 0 0 / 0.08)',
        '--color-border-secondary': 'oklch(0.93 0 0 / 0.05)',
        '--font-sans':
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        '--font-mono': 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
        '--border-radius-sm': '4px',
        '--border-radius-md': '8px',
        '--border-radius-lg': '12px',
        // McpUiStyles requires all keys but treats absent ones as undefined —
        // cast via unknown to provide only the subset we define.
      } as unknown as McpUiStyles,
    },
  };
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
  /**
   * Tool call arguments passed to render_artifact (title, type, etc.).
   * When provided, sent to the artifact app as tool-input before the result,
   * allowing it to show a skeleton with artifact-specific context.
   */
  toolInput?: Record<string, unknown>;
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
  toolInput,
  agentSlug,
  isLoading = false,
}: ArtifactCardProps) {
  const v = VARIANTS[resolveVariant(agentSlug)];
  const [shimmerFade0, shimmerFade50] = SHIMMER_COLORS[resolveVariant(agentSlug)];

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);

  // Bridge lifecycle state
  const [iframeReady, setIframeReady] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);

  // Display mode state — starts as 'inline', can be requested to 'fullscreen'
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>('inline');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Container dimensions tracked by ResizeObserver
  const [containerSize, setContainerSize] = useState({ width: 640, height: 420 });

  // Track native fullscreen state and sync with displayMode
  useEffect(() => {
    const onChange = () => {
      const inFullscreen = !!document.fullscreenElement;
      setIsFullscreen(inFullscreen);
      const newMode: McpUiDisplayMode = inFullscreen ? 'fullscreen' : 'inline';
      setDisplayMode(newMode);
      // Notify the artifact app of the display mode change (setHostContext returns void)
      bridgeRef.current?.setHostContext({ displayMode: newMode });
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ResizeObserver — tracks container dimensions and forwards them to the app
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const rounded = { width: Math.round(width), height: Math.round(height) };
      setContainerSize(rounded);
      // Push updated dimensions to the running bridge (setHostContext returns void)
      bridgeRef.current?.setHostContext({
        containerDimensions: { width: rounded.width, height: rounded.height },
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
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

  // ---------------------------------------------------------------------------
  // Bridge setup — called once when the iframe finishes loading
  // ---------------------------------------------------------------------------

  const setupBridge = useCallback(() => {
    setIframeReady(true);
    if (!iframeRef.current?.contentWindow) return;

    const hostContext = buildHostContext({
      displayMode,
      containerWidth: containerSize.width,
      containerHeight: containerSize.height,
    });

    // AppBridge(client, hostInfo, capabilities, options)
    // hostContext is passed in the 4th HostOptions parameter (not capabilities).
    const bridge = new AppBridge(null, { name: 'Agendo', version: '1.0.0' }, {}, { hostContext });

    bridge.oninitialized = () => {
      setBridgeReady(true);
    };

    // Handle display mode requests from the artifact app
    bridge.onrequestdisplaymode = async ({ mode }) => {
      if (mode === 'fullscreen' && iframeRef.current) {
        try {
          await iframeRef.current.requestFullscreen();
          return { mode: 'fullscreen' };
        } catch {
          // Fullscreen request may be denied (e.g. not triggered by user gesture)
        }
      }
      // Unsupported mode or failed request — return current mode
      return { mode: displayMode };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on iframe load — dependencies intentionally excluded

  // ---------------------------------------------------------------------------
  // Send tool-input notification after bridge is ready
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!bridgeReady || !toolInput || !bridgeRef.current) return;
    void bridgeRef.current.sendToolInput({ arguments: toolInput }).catch(console.error);
  }, [bridgeReady, toolInput]);

  // ---------------------------------------------------------------------------
  // Send tool-result notification when execution completes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!bridgeReady || !toolResultText || !bridgeRef.current) return;
    void bridgeRef.current
      .sendToolResult({ content: [{ type: 'text', text: toolResultText }] })
      .catch(console.error);
  }, [bridgeReady, toolResultText]);

  // ---------------------------------------------------------------------------
  // Teardown bridge on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      bridgeRef.current?.teardownResource({}).catch(() => {});
    };
  }, []);

  // Preload URL: always load the /mcp-app page as soon as we have a title.
  // Including artifactId in the URL enables the fast-path fetch in /mcp-app
  // (no bridge wait needed). Without artifactId the app shows a loading
  // spinner and waits for the bridge to send tool-result.
  const baseUrl = `/mcp-app?title=${encodeURIComponent(title)}&type=${artifactType}`;
  const viewerUrl = artifactId
    ? `${baseUrl}&artifactId=${encodeURIComponent(artifactId)}`
    : baseUrl;

  // ---------------------------------------------------------------------------
  // Shared header
  // ---------------------------------------------------------------------------

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
          <a
            href={viewerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded hover:bg-white/[0.07] text-white/25 hover:text-white/55 transition-colors"
            title="Open in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Render — the iframe is always rendered (for bridge continuity and preloading).
  // An overlay is shown during the loading / not-yet-ready phases.
  // ---------------------------------------------------------------------------

  return (
    <div
      className={cn(
        'my-3 rounded-lg border border-white/[0.07] overflow-hidden border-l-2',
        v.borderL,
      )}
    >
      {headerJsx(isLoading)}

      {/* Container — responsive min-height, grows with content up to 600px */}
      <div
        ref={containerRef}
        className="relative"
        style={{ minHeight: 180, height: isLoading ? 180 : 420 }}
      >
        {/* Skeleton overlay: tool is still executing */}
        {isLoading && (
          <div className="absolute inset-0 z-10 pointer-events-none">
            <div className="absolute inset-0 bg-[oklch(0.075_0_0)]" />
            <div className="absolute inset-0 animate-shimmer" style={shimmerStyle} />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
              <Loader2 className={cn('h-5 w-5 animate-spin opacity-30', v.accentText)} />
              <span className="text-[11px] text-white/20 font-mono tracking-wider">
                generating…
              </span>
            </div>
          </div>
        )}

        {/* iframe spinner overlay: iframe loaded but bridge not yet ready */}
        {!isLoading && !iframeReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-[oklch(0.075_0_0)] z-10">
            <Loader2 className={cn('h-5 w-5 animate-spin opacity-25', v.accentText)} />
          </div>
        )}

        {/* The iframe is always rendered so the bridge can preload during skeleton phase */}
        <iframe
          ref={iframeRef}
          src={viewerUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-fullscreen"
          allow="fullscreen"
          allowFullScreen
          className={cn(
            'w-full h-full border-0 transition-opacity duration-300',
            // Hide iframe visually during loading overlay (still preloads in background)
            isLoading || !iframeReady ? 'opacity-0' : 'opacity-100',
          )}
          title={title}
          onLoad={setupBridge}
        />
      </div>
    </div>
  );
}

'use client';

import { useState, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import DOMPurify from 'isomorphic-dompurify';
import { getErrorMessage } from '@/lib/utils/error-utils';

interface ArtifactData {
  id: string;
  title: string;
  type: 'html' | 'svg';
  content: string;
}

// ---------------------------------------------------------------------------
// ArtifactViewer — the inner component that uses the useApp hook
// ---------------------------------------------------------------------------

function ArtifactViewer() {
  const searchParams = useSearchParams();
  const artifactId = searchParams.get('artifactId');
  const title = searchParams.get('title') ?? 'Artifact';

  const [artifact, setArtifact] = useState<ArtifactData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sanitize SVG content — strips script elements and event handlers while preserving shapes.
  const sanitizedSvg = useMemo(() => {
    if (!artifact || artifact.type !== 'svg') return null;
    return DOMPurify.sanitize(artifact.content, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
  }, [artifact]);

  async function fetchArtifact(id: string) {
    try {
      const resp = await fetch(`/api/artifacts/${id}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { data } = (await resp.json()) as { data: ArtifactData };
      setArtifact(data);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  // ---------------------------------------------------------------------------
  // MCP App bridge — useApp replaces manual App + PostMessageTransport setup.
  // onAppCreated is called before the connect() handshake, so handlers are
  // guaranteed to be in place before the first message from the host arrives.
  // ---------------------------------------------------------------------------
  const { app } = useApp({
    appInfo: { name: 'AgendoArtifactViewer', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (instance) => {
      // Fast path: if artifactId is in the URL, fetch it immediately without
      // waiting for the bridge (works for external hosts and standalone mode).
      if (artifactId) {
        void fetchArtifact(artifactId);
      }

      // tool-input: host sends this notification before tool-result, allowing
      // us to show artifact-specific loading state (title, type) early.
      instance.ontoolinput = (input) => {
        const args = input.arguments as { title?: string; type?: string } | undefined;
        // Future: use args to show "rendering <title>…" skeleton
        void args;
      };

      // tool-result: host sends the completed artifact metadata (id, title, type).
      instance.ontoolresult = (result) => {
        const text = result.content?.find(
          (c): c is { type: 'text'; text: string } => c.type === 'text',
        )?.text;
        if (!text) return;
        try {
          const data = JSON.parse(text) as { id: string; title: string; type: 'html' | 'svg' };
          // Only fetch if we haven't already loaded via URL fast path
          if (!artifact) void fetchArtifact(data.id);
        } catch {
          setError('Failed to parse artifact data');
        }
      };

      instance.onerror = (err: Error) => {
        // Connect failure is expected in standalone mode (no host)
        if (!artifactId) {
          // No URL params either — genuine error
          console.warn('MCP App error (no artifactId fallback):', err.message);
        }
      };
    },
  });

  // Apply host theme (CSS variables + color-scheme) so the artifact viewer
  // matches the host's dark/light mode automatically.
  useHostStyles(app, app?.getHostContext());

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4 text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[oklch(0.075_0_0)]">
        <div className="h-5 w-5 rounded-full border-2 border-white/10 border-t-white/40 animate-spin" />
        <span className="text-[11px] text-white/25 font-mono tracking-wider">
          {title !== 'Artifact' ? `loading ${title}…` : 'loading…'}
        </span>
      </div>
    );
  }

  if (artifact.type === 'svg' && sanitizedSvg !== null) {
    // SVG is sanitized via DOMPurify (svg profile) before rendering — scripts and
    // event handlers are stripped while preserving shapes, paths, and filters.
    return (
      <div
        className="flex items-center justify-center p-4 overflow-auto [&>svg]:max-w-full [&>svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
      />
    );
  }

  // HTML artifact: render in inner sandboxed iframe.
  // allow-same-origin is required by the MCP Apps spec (2026-01-26) and enables
  // external font loading (Google Fonts, @import), CSS animations, and other
  // sub-resource requests that browsers may restrict from null-origin frames.
  // The iframe content is already isolated by the outer ArtifactCard iframe which
  // prevents direct DOM/cookie access to the main agendo origin.
  return (
    <iframe
      srcDoc={artifact.content}
      sandbox="allow-scripts allow-same-origin allow-forms"
      className="w-full h-full border-0"
      title={artifact.title ?? title}
    />
  );
}

export default function McpAppPage() {
  return (
    <div className="h-screen w-full overflow-hidden bg-background">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading...
          </div>
        }
      >
        <ArtifactViewer />
      </Suspense>
    </div>
  );
}

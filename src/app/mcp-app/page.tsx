'use client';

import { useEffect, useState, useRef, Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { App } from '@modelcontextprotocol/ext-apps';
import { PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import DOMPurify from 'isomorphic-dompurify';
import { getErrorMessage } from '@/lib/utils/error-utils';

interface ArtifactData {
  id: string;
  title: string;
  type: 'html' | 'svg';
  content: string;
}

function ArtifactViewer() {
  const searchParams = useSearchParams();
  const artifactId = searchParams.get('artifactId');
  const title = searchParams.get('title') ?? 'Artifact';

  const [artifact, setArtifact] = useState<ArtifactData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appRef = useRef<App | null>(null);

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

  useEffect(() => {
    // Fast path: when artifactId is in the URL, fetch immediately without
    // waiting for the MCP App bridge handshake (which can be slow/fail).
    if (artifactId) {
      void fetchArtifact(artifactId);
    }

    // Also set up the MCP App bridge for external hosts (Claude.ai, Cursor)
    // that provide artifact data via PostMessage instead of URL params.
    const app = new App({ name: 'AgendoArtifactViewer', version: '1.0.0' });
    appRef.current = app;

    app.ontoolresult = (result) => {
      const text = result.content?.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      )?.text;
      if (!text) return;
      try {
        const data = JSON.parse(text) as { id: string; title: string; type: 'html' | 'svg' };
        void fetchArtifact(data.id);
      } catch {
        setError('Failed to parse artifact data');
      }
    };

    const transport = new PostMessageTransport(window.parent, window.parent);
    app.connect(transport).catch((err: Error) => {
      console.warn('MCP App connect failed (standalone mode):', err.message);
      // artifactId already handled above — no duplicate fetch needed
    });

    return () => {
      app.close().catch(() => {});
    };
  }, [artifactId]);

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
        <span className="text-[11px] text-white/25 font-mono tracking-wider">loading…</span>
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

  // HTML artifact: render in inner sandboxed iframe (no allow-same-origin).
  return (
    <iframe
      srcDoc={artifact.content}
      sandbox="allow-scripts allow-forms"
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

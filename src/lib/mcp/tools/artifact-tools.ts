/**
 * Artifact tools: render_artifact (MCP App)
 *
 * Uses the official MCP Apps standard via @modelcontextprotocol/ext-apps.
 * The tool is registered with _meta.ui pointing to ui://agendo/artifact,
 * which marks it as an MCP App tool for compatible hosts (Claude.ai, Cursor, Goose).
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { apiCall, wrapToolCall } from './shared.js';

const VIEWER_URI = 'ui://agendo/artifact';

// Minimal viewer HTML for external MCP hosts (Claude.ai, Cursor, Goose).
// Agendo's own frontend uses the /mcp-app Next.js page instead.
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agendo Artifact</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #0f0f0f; color: #e5e5e5; }
    #container { display: flex; flex-direction: column; gap: 12px; }
    #loading { color: #888; font-size: 14px; }
    #artifact-frame { width: 100%; height: 400px; border: 1px solid #333; border-radius: 8px; background: #fff; }
    #svg-container { display: flex; justify-content: center; }
  </style>
</head>
<body>
  <div id="container">
    <div id="loading">Loading artifact...</div>
    <iframe id="artifact-frame" sandbox="allow-scripts allow-forms" style="display:none"></iframe>
    <div id="svg-container"></div>
  </div>
  <script>
    var agendoBase = 'http://localhost:4100';

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.method === 'ui/initialize') {
        if (msg.params && msg.params.hostContext && msg.params.hostContext.agendoBaseUrl) {
          agendoBase = msg.params.hostContext.agendoBaseUrl;
        }
        event.source.postMessage({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: '2026-01-26',
            hostCapabilities: {},
            hostInfo: { name: 'AgendoViewer', version: '1.0.0' },
            hostContext: {}
          }
        }, event.origin || '*');
        setTimeout(function() {
          event.source.postMessage({
            jsonrpc: '2.0',
            method: 'ui/notifications/initialized'
          }, event.origin || '*');
        }, 0);
      }

      if (msg.method === 'ui/notifications/tool-result') {
        var content = msg.params && msg.params.result && msg.params.result.content;
        if (!content || !content[0] || !content[0].text) return;
        try {
          var artifact = JSON.parse(content[0].text);
          loadArtifact(artifact.id, artifact.type);
        } catch (e) {
          document.getElementById('loading').textContent = 'Error parsing artifact data.';
        }
      }
    });

    function loadArtifact(id, type) {
      document.getElementById('loading').textContent = 'Fetching artifact...';
      fetch(agendoBase + '/api/artifacts/' + id)
        .then(function(resp) { return resp.json(); })
        .then(function(json) {
          document.getElementById('loading').style.display = 'none';
          if (type === 'svg') {
            document.getElementById('svg-container').innerHTML = json.data.content;
          } else {
            var frame = document.getElementById('artifact-frame');
            frame.srcdoc = json.data.content;
            frame.style.display = 'block';
          }
        })
        .catch(function(e) {
          document.getElementById('loading').textContent = 'Error loading artifact: ' + e.message;
        });
    }
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleRenderArtifact(args: {
  title: string;
  content: string;
  type?: 'html' | 'svg';
}): Promise<unknown> {
  const sessionId = process.env.AGENDO_SESSION_ID;
  const result = (await apiCall('/api/artifacts', {
    method: 'POST',
    body: {
      title: args.title,
      content: args.content,
      type: args.type ?? 'html',
      ...(sessionId ? { sessionId } : {}),
    },
  })) as Record<string, unknown>;
  // Return only metadata — strip the large `content` field to stay within
  // PG NOTIFY's ~7500 byte limit.  The frontend fetches content via
  // GET /api/artifacts/:id when rendering the iframe.
  const { content: _content, ...metadata } = result;
  return metadata;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerArtifactTools(server: McpServer): void {
  registerAppTool(
    server,
    'render_artifact',
    {
      title: 'Render Artifact',
      description:
        'Render an interactive visual (chart, dashboard, diagram, UI mockup, SVG) inline in the Agendo chat. Use when a visual communicates better than text. Design guidelines are pre-loaded via the artifact-design skill — apply them when writing HTML/SVG.',
      inputSchema: {
        title: z.string().min(1).max(500).describe('Short descriptive title for the visual'),
        content: z
          .string()
          .min(1)
          .describe(
            'Full <!DOCTYPE html> document with inline CSS/JS, or SVG markup. Google Fonts @import and CDN scripts (Chart.js, D3, Anime.js) are allowed.',
          ),
        type: z
          .enum(['html', 'svg'])
          .optional()
          .default('html')
          .describe('Content type: "html" for full HTML documents, "svg" for SVG markup'),
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    (args: { title: string; content: string; type?: 'html' | 'svg' }) =>
      wrapToolCall(() => handleRenderArtifact(args)),
  );

  registerAppResource(
    server,
    'Agendo Artifact Viewer',
    VIEWER_URI,
    { description: 'Interactive artifact viewer for Agendo. Renders HTML/SVG artifacts inline.' },
    async () => ({
      contents: [{ uri: VIEWER_URI, mimeType: RESOURCE_MIME_TYPE, text: VIEWER_HTML }],
    }),
  );
}

import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Read version from package.json at build time
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };
const gitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_GIT_SHA: gitSha,
    // Expose the worker HTTP port so the browser can connect directly to SSE
    // streams. The Next.js proxy (route handler) has an internal timeout that
    // kills long-lived SSE streams after ~70s. Direct connection has no timeout.
    NEXT_PUBLIC_WORKER_HTTP_PORT: process.env.WORKER_HTTP_PORT ?? '4102',
  },
  serverExternalPackages: ['pg'],
  typescript: {
    // Type checking runs separately via `pnpm typecheck`.
    // Skipping it here avoids OOM on the 4GB build server.
    ignoreBuildErrors: true,
  },
  experimental: {
    // @dnd-kit packages are not in Next.js's built-in optimizePackageImports list.
    // Adding them here enables tree-shaking of barrel imports so only the
    // specific modules used (DndContext, useSortable, etc.) are bundled.
    optimizePackageImports: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
  },
  async headers() {
    // CSP for /mcp-app — this page is sandboxed inside an iframe and renders
    // agent-generated artifacts. Restrictive policy per MCP Apps spec 2026-01-26:
    // hosts must enforce CSP when the MCP server does not declare ui.csp.
    // - script-src / style-src: 'unsafe-inline' required for Next.js inline bundles
    // - connect-src 'self': only our own API (/api/artifacts/:id)
    // - frame-src 'self' blob: data:: inner srcdoc iframe (artifact HTML content)
    // - img-src: data: / blob: for inline images in artifacts
    // - report-uri: logs violations for security auditing
    const mcpAppCsp = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' blob: data:",
      'worker-src blob:',
      'report-uri /api/csp-report',
    ].join('; ');

    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
      {
        source: '/mcp-app',
        headers: [{ key: 'Content-Security-Policy', value: mcpAppCsp }],
      },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
  async rewrites() {
    const workerPort = process.env.WORKER_HTTP_PORT ?? '4102';
    return [
      {
        source: '/api/sessions/:id/live',
        destination: `http://localhost:${workerPort}/sessions/:id/events`,
      },
      {
        source: '/api/brainstorms/:id/live',
        destination: `http://localhost:${workerPort}/brainstorms/:id/events`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;

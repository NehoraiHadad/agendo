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

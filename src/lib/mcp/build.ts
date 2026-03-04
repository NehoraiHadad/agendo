import { build } from 'esbuild';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp-build');

async function main() {
  await build({
    entryPoints: ['src/lib/mcp/server.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: 'dist/mcp-server.js',
    banner: { js: '#!/usr/bin/env node\n' },
    sourcemap: true,
  });
  log.info('MCP server built: dist/mcp-server.js');
}

main().catch((err) => {
  log.error({ err }, 'Build failed');
  process.exit(1);
});

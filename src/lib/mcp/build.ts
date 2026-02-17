import { build } from 'esbuild';

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
  console.log('MCP server built: dist/mcp-server.js');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});

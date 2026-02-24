#!/usr/bin/env tsx
/**
 * Generates PWA icon sizes from public/logo.png using sharp.
 * Run once: npx tsx scripts/generate-pwa-icons.ts
 */

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'public', 'logo.png');
const OUT = join(ROOT, 'public', 'icons');

const icons = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

async function main() {
  mkdirSync(OUT, { recursive: true });

  for (const { name, size } of icons) {
    await sharp(SRC)
      .resize(size, size, { fit: 'contain', background: { r: 13, g: 13, b: 14, alpha: 1 } })
      .png()
      .toFile(join(OUT, name));
    console.log(`✓ ${name} (${size}×${size})`);
  }

  console.log('\nIcons written to public/icons/');
}

main().catch(console.error);

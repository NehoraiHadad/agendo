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

  // badge-72.png — monochrome white on transparent, for Android status bar
  // Android ignores color in badge icons and renders them as white silhouettes.
  // A full-color icon appears as a white square; we must supply a proper mask.
  const BADGE_SIZE = 96; // 96×96 recommended for Android up to 4x device pixel ratio
  const maskBuffer = await sharp(SRC)
    .resize(BADGE_SIZE, BADGE_SIZE, { fit: 'cover' })
    .greyscale()
    .threshold(20) // isolate logo shapes from the black background
    .toBuffer();

  const whiteRgb = await sharp({
    create: {
      width: BADGE_SIZE,
      height: BADGE_SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();

  await sharp(whiteRgb)
    .joinChannel(maskBuffer) // use grayscale mask as alpha channel → white shape on transparent
    .toFile(join(OUT, 'badge-96.png'));
  console.log(`✓ badge-96.png (${BADGE_SIZE}×${BADGE_SIZE}, monochrome)`);

  console.log('\nIcons written to public/icons/');
}

main().catch(console.error);

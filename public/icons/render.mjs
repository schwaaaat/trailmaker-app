#!/usr/bin/env node

/**
 * public/icons/render.mjs
 * Renders the full PWA icon set from vector SVGs using sharp.
 * Run with: node public/icons/render.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPublic = path.resolve(__dirname, '..');
const iconsDir = __dirname;

const masterSvgPath = path.join(iconsDir, 'icon.svg');
const maskableSvgPath = path.join(iconsDir, 'icon-maskable.svg');

if (!fs.existsSync(masterSvgPath)) {
  console.error(`Missing master SVG: ${masterSvgPath}`);
  process.exit(1);
}
if (!fs.existsSync(maskableSvgPath)) {
  console.error(`Missing maskable SVG: ${maskableSvgPath}`);
  process.exit(1);
}

const masterSvgBuffer = fs.readFileSync(masterSvgPath);
const maskableSvgBuffer = fs.readFileSync(maskableSvgPath);

const renders = [
  {
    name: 'icon-192.png',
    input: masterSvgBuffer,
    dest: path.join(iconsDir, 'icon-192.png'),
    size: 192,
  },
  {
    name: 'icon-512.png',
    input: masterSvgBuffer,
    dest: path.join(iconsDir, 'icon-512.png'),
    size: 512,
  },
  {
    name: 'icon-maskable-192.png',
    input: maskableSvgBuffer,
    dest: path.join(iconsDir, 'icon-maskable-192.png'),
    size: 192,
  },
  {
    name: 'icon-maskable-512.png',
    input: maskableSvgBuffer,
    dest: path.join(iconsDir, 'icon-maskable-512.png'),
    size: 512,
  },
  {
    name: 'apple-touch-icon.png (in icons/)',
    input: maskableSvgBuffer,
    dest: path.join(iconsDir, 'apple-touch-icon.png'),
    size: 180,
  },
  {
    name: 'apple-touch-icon.png (in public/)',
    input: maskableSvgBuffer,
    dest: path.join(rootPublic, 'apple-touch-icon.png'),
    size: 180,
  },
];

console.log('Rendering Trailmaker PWA icons with sharp...');

for (const item of renders) {
  await sharp(item.input)
    .resize(item.size, item.size)
    .png({ compressionLevel: 9 })
    .toFile(item.dest);

  const stats = fs.statSync(item.dest);
  console.log(`  ✓ ${item.name} (${item.size}x${item.size}) -> ${stats.size} bytes`);
}

console.log('Icon render complete.');

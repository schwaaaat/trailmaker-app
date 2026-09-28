import { deflateSync } from 'node:zlib';

export const basemapBounds = [-78.41, 38.57, -78.35, 38.61] as const;
export const minZoom = 10;
export const maxZoom = 16;
const size = 256;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const bytes = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  bytes.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

/** XYZ coordinates for a longitude/latitude point, using Web Mercator. */
export function tileXY(lon: number, lat: number, zoom: number): readonly [number, number] {
  const scale = 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [
    Math.floor(((lon + 180) / 360) * scale),
    Math.floor(((1 - Math.log((1 + sin) / (1 - sin)) / (2 * Math.PI)) / 2) * scale),
  ];
}

/** Keep the route finite while allowing one tile of pan around every truth point. */
export function coversTile(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < minZoom || z > maxZoom) return false;
  const [west, south, east, north] = basemapBounds;
  const [minX, minY] = tileXY(west, north, z);
  const [maxX, maxY] = tileXY(east, south, z);
  return x >= minX - 1 && x <= maxX + 1 && y >= minY - 1 && y <= maxY + 1;
}

/** Coordinate-coded checkerboard: same z/x/y always produces the same PNG bytes. */
export async function fixtureTilePng(z: number, x: number, y: number): Promise<Buffer> {
  if (!coversTile(z, x, y)) throw new RangeError('Tile is outside the fixture extent');
  const pixels = Buffer.alloc(size * (1 + size * 4));
  const tint = (Math.imul(x, 31) ^ Math.imul(y, 17) ^ Math.imul(z, 47)) & 31;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * (1 + size * 4) + 1 + px * 4;
      const checker = ((px >> 6) + (py >> 6) + x + y) & 1;
      const grid = px % 64 < 2 || py % 64 < 2;
      pixels[i] = grid ? 72 : checker ? 225 - tint : 239 - tint;
      pixels[i + 1] = grid ? 112 : checker ? 233 - tint : 243 - tint;
      pixels[i + 2] = grid ? 129 : checker ? 224 - tint : 232 - tint;
      pixels[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // channel depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

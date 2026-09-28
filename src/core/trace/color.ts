import type { HexColor, Rgb } from '../types';

export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function rgbToHsl([red, green, blue]: Rgb): readonly [h: number, s: number, l: number] {
  const r = red / 255,
    g = green / 255,
    b = blue / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2,
    delta = max - min;
  let h = 0,
    s = 0;
  if (delta > 1e-6) {
    s = delta / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s, l];
}

export function nameColor(rgb: Rgb): string {
  const [h, s, l] = rgbToHsl(rgb);
  if (l < 0.16) return 'Black';
  if (s < 0.16) return l > 0.82 ? 'White' : 'Gray';
  if ((h < 45 || h >= 340) && l < 0.42 && s < 0.65 && h >= 10) return 'Brown';
  if (h < 12 || h >= 345) return 'Red';
  if (h < 42) return l < 0.35 ? 'Brown' : 'Orange';
  if (h < 68) return 'Yellow';
  if (h < 160) return 'Green';
  if (h < 195) return 'Teal';
  if (h < 250) return 'Blue';
  if (h < 290) return 'Purple';
  return 'Pink';
}

export function rgbToHex(rgb: Rgb): HexColor {
  return (
    '#' +
    rgb
      .map((channel) =>
        Math.max(0, Math.min(255, Math.round(channel)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = match[1]!;
  return value.length === 3
    ? [
        parseInt(value[0]! + value[0]!, 16),
        parseInt(value[1]! + value[1]!, 16),
        parseInt(value[2]! + value[2]!, 16),
      ]
    : [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
      ];
}

export function luminance(rgb: Rgb): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

export function featureColorForInk(ink: Rgb, fallback: HexColor): HexColor {
  return luminance(ink) < 0.82 ? rgbToHex(ink) : fallback;
}

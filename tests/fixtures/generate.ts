import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Px, Rgb } from '../../src/core/types';
import { pixelToLatLon, warpPixel, type FixtureTruth, type TruthLine } from './truth';

export const fixtureNames = [
  'solid',
  'dashed',
  'dotted',
  'crossings',
  'clutter',
  'jpeg-noise',
  'blur',
  'warped',
  'benchmark',
] as const;
export type FixtureName = (typeof fixtureNames)[number];
export const colors: Rgb[] = [
  [205, 48, 48],
  [35, 96, 195],
  [38, 132, 65],
];
const n = (value: number) => Number(value.toFixed(4));

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function makeTruth(name: FixtureName, seed = 20260924): FixtureTruth {
  const width = name === 'benchmark' ? 3000 : 800;
  const height = name === 'benchmark' ? 2200 : 600;
  const scale = width / 800;
  const rng = random(seed);
  const transform = {
    origin: [38.6, -78.4] as const,
    metersPerPixel: 1,
    metersPerDegree: [111320 * Math.cos((38.6 * Math.PI) / 180), 111320] as const,
    warp: { amplitude: name === 'warped' ? 9 : 0, period: height },
  };
  const polylines: TruthLine[] = [];
  const add = (id: string, pts: Px[], color: Rgb, style: TruthLine['style'] = 'solid') => {
    // Subdivide before warping: image, PDF, metrics and truth all use these same vertices.
    const dense: Px[] = [];
    pts.slice(1).forEach((b, index) => {
      const a = pts[index]!;
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 8);
      for (let i = 0; i < steps; i++)
        dense.push([a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]);
    });
    dense.push(pts[pts.length - 1]!);
    polylines.push({
      id,
      color,
      style,
      pts: dense.map(
        ([x, y]) => warpPixel([x * scale, (y * height) / 600], transform).map(n) as unknown as Px,
      ),
    });
  };
  const style = name === 'dashed' ? 'dashed' : name === 'dotted' ? 'dotted' : 'solid';
  add(
    'red-ridge',
    [
      [70, 160],
      [470, 160],
      [610, 200 + rng() * 20],
      [720, 280],
    ],
    colors[0]!,
    style,
  );
  add(
    'blue-creek',
    [
      [80, 380],
      [220, 330 + rng() * 20],
      [390, 380],
      [700, 370],
    ],
    colors[1]!,
    style,
  );
  if (['crossings', 'clutter', 'jpeg-noise', 'blur', 'warped', 'benchmark'].includes(name)) {
    add(
      'red-crossing',
      [
        [300, 70],
        [300, 260],
      ],
      colors[0]!,
    );
    add(
      'green-crossing',
      [
        [520, 70],
        [520, 470],
      ],
      colors[2]!,
    );
  }
  if (name === 'benchmark') {
    add(
      'red-dashed',
      [
        [80, 450],
        [280, 480],
        [400, 440],
      ],
      colors[0]!,
      'dashed',
    );
    add(
      'blue-dotted',
      [
        [560, 460],
        [640, 440],
        [730, 480],
      ],
      colors[1]!,
      'dotted',
    );
  }
  const anchors = (
    [
      [40, 40],
      [400, 40],
      [760, 40],
      [40, 560],
      [400, 560],
      [760, 560],
    ] as Px[]
  ).map((point, index) => {
    const px = warpPixel([point[0] * scale, (point[1] * height) / 600], transform);
    return { id: `a${index + 1}`, px, ll: pixelToLatLon(px, transform), source: 'paste' as const };
  });
  const poi: Px = [120 * scale, (220 * height) / 600];
  return {
    version: 1,
    name,
    seed,
    width,
    height,
    transform,
    polylines,
    anchors,
    pois: [{ name: 'Trailhead', px: poi, ll: pixelToLatLon(poi, transform) }],
    challenges: [
      name,
      ...(name === 'crossings' ? ['same-color-crossing', 'different-color-crossing'] : []),
      ...(name === 'clutter' || name === 'benchmark'
        ? ['trail-colored-labels', 'filled-zones', 'legend-swatches']
        : []),
    ],
  };
}

const colorCss = (color: Rgb) => `rgb(${color.join(',')})`;
function svg(truth: FixtureTruth): string {
  const lines = truth.polylines
    .map(
      (line) =>
        `<polyline points="${line.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${colorCss(line.color)}" stroke-width="4" stroke-linecap="round" ${line.style === 'dashed' ? 'stroke-dasharray="12 8"' : line.style === 'dotted' ? 'stroke-dasharray="1 8"' : ''}/>`,
    )
    .join('');
  const sx = truth.width / 800;
  const sy = truth.height / 600;
  const clutter = truth.challenges.includes('filled-zones')
    ? `<g transform="scale(${sx} ${sy})"><rect x="610" y="490" width="130" height="65" fill="${colorCss(colors[2]!)}"/><text x="80" y="290" fill="${colorCss(colors[0]!)}" font-family="sans-serif" font-size="24">RIDGE TRAIL</text><rect x="80" y="510" width="38" height="14" fill="${colorCss(colors[0]!)}"/><rect x="80" y="535" width="38" height="14" fill="${colorCss(colors[1]!)}"/><text x="132" y="523" font-family="sans-serif" font-size="16">Ridge</text><text x="132" y="548" font-family="sans-serif" font-size="16">Creek</text></g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${truth.width}" height="${truth.height}"><rect width="100%" height="100%" fill="#faf8ed"/>${clutter}${lines}</svg>`;
}

export async function renderFixture(name: FixtureName, seed = 20260924) {
  const truth = makeTruth(name, seed);
  let raster = sharp(Buffer.from(svg(truth)));
  if (name === 'blur') raster = raster.blur(0.7);
  if (name === 'jpeg-noise')
    raster = sharp(await raster.jpeg({ quality: 38, chromaSubsampling: '4:2:0' }).toBuffer());
  const png = await raster.png({ compressionLevel: 9 }).toBuffer();
  const pdf = await renderPdf(truth);
  return { truth, png, pdf };
}

async function renderPdf(truth: FixtureTruth): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2000-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  pdf.setProducer('Trailmaker deterministic fixture generator');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const cover = pdf.addPage([truth.width, truth.height]);
  cover.drawText('Trailmaker fixture - map on page 2', {
    x: 40,
    y: truth.height - 60,
    size: 22,
    font,
  });
  const page = pdf.addPage([truth.width, truth.height]);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: truth.width,
    height: truth.height,
    color: rgb(250 / 255, 248 / 255, 237 / 255),
  });
  for (const line of truth.polylines) {
    const path = line.pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
    page.drawSvgPath(path, {
      x: 0,
      y: truth.height,
      borderColor: rgb(line.color[0] / 255, line.color[1] / 255, line.color[2] / 255),
      borderWidth: 4,
      ...(line.style === 'solid'
        ? {}
        : { borderDashArray: line.style === 'dashed' ? [12, 8] : [1, 8] }),
    });
  }
  if (truth.challenges.includes('filled-zones')) {
    const sx = truth.width / 800,
      sy = truth.height / 600;
    page.drawRectangle({
      x: 610 * sx,
      y: truth.height - 555 * sy,
      width: 130 * sx,
      height: 65 * sy,
      color: rgb(38 / 255, 132 / 255, 65 / 255),
    });
    page.drawText('RIDGE TRAIL', {
      x: 80 * sx,
      y: truth.height - 290 * sy,
      size: 24 * sx,
      color: rgb(205 / 255, 48 / 255, 48 / 255),
      font,
    });
    for (const [index, label] of ['Ridge', 'Creek'].entries()) {
      const c = colors[index]!;
      page.drawRectangle({
        x: 80 * sx,
        y: truth.height - (524 + index * 25) * sy,
        width: 38 * sx,
        height: 14 * sy,
        color: rgb(c[0] / 255, c[1] / 255, c[2] / 255),
      });
      page.drawText(label, {
        x: 132 * sx,
        y: truth.height - (523 + index * 25) * sy,
        size: 16 * sx,
        font,
      });
    }
  }
  return pdf.save({ useObjectStreams: false });
}

/**
 * Output is deterministic, so skip files that already hold the same bytes. Several test files call
 * generate() in setup while others read the fixtures in parallel workers; rewriting identical files
 * let a reader catch a half-written PNG ("corrupt header").
 */
async function writeIfChanged(file: string, data: Uint8Array | string): Promise<void> {
  const next = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  const current = await readFile(file).catch(() => null);
  if (current?.equals(next)) return;
  await writeFile(file, next);
}

export async function generate(output = 'tests/fixtures/generated', seed = 20260924) {
  await mkdir(output, { recursive: true });
  for (const name of fixtureNames) {
    const { truth, png, pdf } = await renderFixture(name, seed);
    await writeIfChanged(resolve(output, `${name}.png`), png);
    await writeIfChanged(resolve(output, `${name}.pdf`), pdf);
    await writeIfChanged(resolve(output, `${name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
  }
  console.info(
    `Generated ${fixtureNames.length} PNG/PDF/truth fixtures (seed ${seed}) in ${output}`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generate();

import type {
  Affine2x3,
  Anchor,
  AnchorId,
  FitFrame,
  FitMethod,
  FitModel,
  FitResult,
  GeoFit,
  KmlOverlay,
  LatLon,
  Px,
  ResolvedFitMethod,
} from '../types';
import { OUTLIER_MIN_M, OUTLIER_RMS_FACTOR, PLAUSIBLE_METERS_PER_PIXEL } from '../types';
import { hasIndependentAffineSupport, supportsAffine } from './conditioning';
export { withLooResiduals } from './loo';
const D2R = Math.PI / 180;
const MDEG = 6378137 * D2R;
const kernel = (r2: number): number => (r2 > 0 ? r2 * Math.log(r2) : 0);
function solve(matrix: readonly (readonly number[])[], rhs: readonly number[]): number[] | null {
  const n = rhs.length,
    a = matrix.map((row) => [...row]),
    b = [...rhs];
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[pivot]![c]!)) pivot = r;
    if (Math.abs(a[pivot]![c]!) < 1e-12) return null;
    [a[c]!, a[pivot]!] = [a[pivot]!, a[c]!];
    [b[c]!, b[pivot]!] = [b[pivot]!, b[c]!];
    for (let r = c + 1; r < n; r++) {
      const factor = a[r]![c]! / a[c]![c]!;
      if (!factor) continue;
      for (let k = c; k < n; k++) a[r]![k]! -= factor * a[c]![k]!;
      b[r]! -= factor * b[c]!;
    }
  }
  const result = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r]!;
    for (let k = r + 1; k < n; k++) sum -= a[r]![k]! * result[k]!;
    result[r]! = sum / a[r]![r]!;
  }
  return result;
}
function leastSquares(
  rows: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] | null {
  const n = rows[0]!.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const right = new Array<number>(n).fill(0);
  rows.forEach((row, k) => {
    for (let i = 0; i < n; i++) {
      right[i]! += row[i]! * rhs[k]!;
      for (let j = 0; j < n; j++) matrix[i]![j]! += row[i]! * row[j]!;
    }
  });
  return solve(matrix, right);
}
function affineEN(a: Affine2x3, u: number, v: number): readonly [number, number] {
  return [a[0]! * u + a[1]! * v + a[2]!, a[3]! * u + a[4]! * v + a[5]!];
}
function modelEN(model: FitModel, u: number, v: number): readonly [number, number] {
  if (model.kind !== 'tps') return affineEN(model.affine, u, v);
  const n = model.controls.length;
  let e = model.weightsE[n]! + model.weightsE[n + 1]! * u + model.weightsE[n + 2]! * v;
  let north = model.weightsN[n]! + model.weightsN[n + 1]! * u + model.weightsN[n + 2]! * v;
  for (let i = 0; i < n; i++) {
    const du = u - model.controls[i]![0]!,
      dv = v - model.controls[i]![1]!;
    const k = kernel(du * du + dv * dv);
    e += model.weightsE[i]! * k;
    north += model.weightsN[i]! * k;
  }
  return [e, north];
}
/** Fit a serializable pixel-to-geography model in the prototype's local meter frame. */
export function fitAnchors(
  anchors: readonly Anchor[],
  width: number,
  height: number,
  requested: FitMethod,
): FitResult {
  const valid = anchors.filter(
    (a) =>
      a.ll !== null &&
      Number.isFinite(a.ll[0]!) &&
      Number.isFinite(a.ll[1]!) &&
      Number.isFinite(a.px[0]!) &&
      Number.isFinite(a.px[1]!),
  );
  if (valid.length < 2)
    return { ok: false, reason: 'too-few', anchorCount: valid.length, need: 2 - valid.length };
  const lat0 = valid.reduce((sum, a) => sum + a.ll![0]!, 0) / valid.length;
  const lon0 = valid.reduce((sum, a) => sum + a.ll![1]!, 0) / valid.length;
  const frame: FitFrame = {
    lat0,
    lon0,
    kx: MDEG * Math.cos(lat0 * D2R),
    ky: MDEG,
    cx: width / 2,
    cy: height / 2,
    scale: Math.max(width, height) || 1,
  };
  const points = valid.map((a) => ({
    id: a.id,
    u: (a.px[0]! - frame.cx) / frame.scale,
    v: (a.px[1]! - frame.cy) / frame.scale,
    E: (a.ll![1]! - lon0) * frame.kx,
    N: (a.ll![0]! - lat0) * frame.ky,
  }));
  const simRows: number[][] = [],
    simRhs: number[] = [];
  for (const p of points) {
    simRows.push([p.u, p.v, 1, 0], [-p.v, p.u, 0, 1]);
    simRhs.push(p.E, p.N);
  }
  const sim = leastSquares(simRows, simRhs);
  const simAffine: Affine2x3 | null = sim
    ? [sim[0]!, sim[1]!, sim[2]!, sim[1]!, -sim[0]!, sim[3]!]
    : null;
  let aff: Affine2x3 | null = null,
    affDet = 0;
  if (points.length >= 3) {
    const rows = points.map((p) => [p.u, p.v, 1]);
    const east = leastSquares(
      rows,
      points.map((p) => p.E),
    );
    const north = leastSquares(
      rows,
      points.map((p) => p.N),
    );
    if (east && north) {
      affDet = east[0]! * north[1]! - east[1]! * north[0]!;
      if (Math.abs(affDet) > 1e-9)
        aff = [east[0]!, east[1]!, east[2]!, north[0]!, north[1]!, north[2]!];
    }
  }
  if (!simAffine && !aff)
    return { ok: false, reason: 'degenerate', anchorCount: points.length, need: 0 };
  const mapSpreadSupportsAffine = aff !== null && supportsAffine(valid.map((point) => point.px));
  const affineIndependentlySupported =
    aff !== null && hasIndependentAffineSupport(valid.map((point) => point.px));
  const affineConditionRequired =
    requested === 'affine' || requested === 'tps' || (requested === 'auto' && points.length >= 4);
  let method: ResolvedFitMethod =
    requested === 'auto'
      ? points.length >= 4 && mapSpreadSupportsAffine
        ? 'affine'
        : 'similarity'
      : requested;
  if (method === 'affine' && !aff) method = 'similarity';
  if (method === 'tps' && (points.length < 4 || !aff)) method = aff ? 'affine' : 'similarity';
  if (method === 'similarity' && !simAffine) method = 'affine';
  let model: FitModel;
  if (method === 'similarity') model = { kind: 'similarity', affine: simAffine! };
  else if (method === 'affine') model = { kind: 'affine', affine: aff! };
  else {
    const n = points.length,
      matrix = Array.from({ length: n + 3 }, () => new Array<number>(n + 3).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const du = points[i]!.u - points[j]!.u,
          dv = points[i]!.v - points[j]!.v;
        matrix[i]![j]! = kernel(du * du + dv * dv);
      }
      matrix[i]![n]! = matrix[n]![i]! = 1;
      matrix[i]![n + 1]! = matrix[n + 1]![i]! = points[i]!.u;
      matrix[i]![n + 2]! = matrix[n + 2]![i]! = points[i]!.v;
    }
    const weightsE = solve(matrix, [...points.map((p) => p.E), 0, 0, 0]);
    const weightsN = solve(matrix, [...points.map((p) => p.N), 0, 0, 0]);
    if (weightsE && weightsN)
      model = {
        kind: 'tps',
        controls: points.map((p) => [p.u, p.v]),
        weightsE,
        weightsN,
        affine: aff!,
      };
    else {
      method = 'affine';
      model = { kind: 'affine', affine: aff! };
    }
  }
  const residualModel: FitModel =
    model.kind === 'tps' ? { kind: 'affine', affine: model.affine } : model;
  const residuals: Record<AnchorId, number> = {};
  let squares = 0;
  for (const p of points) {
    const [e, north] = modelEN(residualModel, p.u, p.v);
    const residual = Math.hypot(e - p.E, north - p.N);
    residuals[p.id]! = residual;
    squares += residual * residual;
  }
  const metersPerPixel =
    (method === 'similarity' ? Math.hypot(sim![0]!, sim![1]!) : Math.sqrt(Math.abs(affDet))) /
    frame.scale;
  return {
    ok: true,
    requested,
    method,
    frame,
    model,
    anchorCount: points.length,
    residuals,
    rms: Math.sqrt(squares / points.length),
    checked:
      points.length > (method === 'similarity' ? 2 : 3) &&
      (!affineConditionRequired || affineIndependentlySupported),
    looResiduals: null,
    metersPerPixel,
    mirrored: method !== 'similarity' && affDet > 0,
    implausibleScale:
      metersPerPixel < PLAUSIBLE_METERS_PER_PIXEL.min ||
      metersPerPixel > PLAUSIBLE_METERS_PER_PIXEL.max,
  };
}
export function forward(fit: GeoFit, [x, y]: Px): LatLon {
  const f = fit.frame;
  const [e, north] = modelEN(fit.model, (x - f.cx) / f.scale, (y - f.cy) / f.scale);
  return [f.lat0 + north / f.ky, f.lon0 + e / f.kx];
}
export function inverse(fit: GeoFit, [lat, lon]: LatLon): Px | null {
  const { frame, model } = fit;
  const targetE = (lon - frame.lon0) * frame.kx,
    targetN = (lat - frame.lat0) * frame.ky;
  const a = model.affine,
    det = a[0]! * a[4]! - a[1]! * a[3]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  let u = (a[4]! * (targetE - a[2]!) - a[1]! * (targetN - a[5]!)) / det;
  let v = (-a[3]! * (targetE - a[2]!) + a[0]! * (targetN - a[5]!)) / det;
  if (model.kind !== 'tps') return [u * frame.scale + frame.cx, v * frame.scale + frame.cy];
  const n = model.controls.length;
  for (let iteration = 0; iteration < 20; iteration++) {
    let e = model.weightsE[n]! + model.weightsE[n + 1]! * u + model.weightsE[n + 2]! * v;
    let north = model.weightsN[n]! + model.weightsN[n + 1]! * u + model.weightsN[n + 2]! * v;
    let eu = model.weightsE[n + 1]!,
      ev = model.weightsE[n + 2]!;
    let nu = model.weightsN[n + 1]!,
      nv = model.weightsN[n + 2]!;
    for (let i = 0; i < n; i++) {
      const du = u - model.controls[i]![0]!,
        dv = v - model.controls[i]![1]!,
        r2 = du * du + dv * dv;
      const k = kernel(r2),
        dk = r2 > 0 ? 2 * (Math.log(r2) + 1) : 0;
      e += model.weightsE[i]! * k;
      north += model.weightsN[i]! * k;
      eu += model.weightsE[i]! * dk * du;
      ev += model.weightsE[i]! * dk * dv;
      nu += model.weightsN[i]! * dk * du;
      nv += model.weightsN[i]! * dk * dv;
    }
    const de = e - targetE,
      dn = north - targetN;
    if (Math.hypot(de, dn) < 1e-7) return [u * frame.scale + frame.cx, v * frame.scale + frame.cy];
    const jacobian = eu * nv - ev * nu;
    if (!Number.isFinite(jacobian) || Math.abs(jacobian) < 1e-12) return null;
    u -= (nv * de - ev * dn) / jacobian;
    v -= (-nu * de + eu * dn) / jacobian;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  }
  return null;
}
export function projectPath(fit: GeoFit, points: readonly Px[]): LatLon[] {
  return points.map((p) => forward(fit, p));
}
export function overlayQuad(fit: GeoFit, width: number, height: number): KmlOverlay['quad'] {
  return [
    forward(fit, [0, height]),
    forward(fit, [width, height]),
    forward(fit, [width, 0]),
    forward(fit, [0, 0]),
  ];
}
/** Build a row-major image-space grid whose geographic nodes follow the complete fit. */
export function overlayMesh(
  fit: GeoFit,
  width: number,
  height: number,
  cells: number,
): { cols: number; rows: number; px: Px[]; ll: LatLon[] } {
  const count = Number.isFinite(cells) ? Math.min(64, Math.max(1, Math.round(cells))) : 1;
  const safeWidth = Math.max(0, width),
    safeHeight = Math.max(0, height);
  const aspect = safeWidth / Math.max(safeHeight, Number.EPSILON);
  const cols = aspect >= 1 ? count : Math.max(1, Math.round(count * aspect));
  const rows = aspect >= 1 ? Math.max(1, Math.round(count / Math.max(aspect, Number.EPSILON))) : count;
  const px: Px[] = [];
  const ll: LatLon[] = [];
  for (let row = 0; row <= rows; row++) {
    const y = (safeHeight * row) / rows;
    for (let col = 0; col <= cols; col++) {
      const point: Px = [(safeWidth * col) / cols, y];
      px.push(point);
      ll.push(forward(fit, point));
    }
  }
  return { cols, rows, px, ll };
}
export function isOutlier(fit: GeoFit, anchorId: AnchorId): boolean {
  return (
    fit.checked &&
    (fit.residuals[anchorId]! ?? 0) > Math.max(OUTLIER_MIN_M, fit.rms * OUTLIER_RMS_FACTOR)
  );
}

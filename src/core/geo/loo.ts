import type { Anchor, GeoFit, LatLon } from '../types';
import { haversine } from './distance';
import { fitAnchors, forward } from './fit';

const kernel = (r2: number): number => (r2 > 0 ? r2 * Math.log(r2) : 0);

function factor(matrix: number[][]): { lu: number[][]; permutation: number[] } | null {
  const size = matrix.length;
  const lu = matrix.map((row) => [...row]);
  const permutation = Array.from({ length: size }, (_, index) => index);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(lu[row]![column]!) > Math.abs(lu[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(lu[pivot]![column]!) < 1e-12) return null;
    [lu[column]!, lu[pivot]!] = [lu[pivot]!, lu[column]!];
    [permutation[column]!, permutation[pivot]!] = [permutation[pivot]!, permutation[column]!];
    for (let row = column + 1; row < size; row++) {
      lu[row]![column]! /= lu[column]![column]!;
      for (let j = column + 1; j < size; j++) lu[row]![j]! -= lu[row]![column]! * lu[column]![j]!;
    }
  }
  return { lu, permutation };
}

function solveFactored(
  lu: readonly (readonly number[])[],
  permutation: readonly number[],
  rhs: readonly number[],
): number[] {
  const size = lu.length;
  const value = permutation.map((index) => rhs[index]!);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < row; column++) value[row]! -= lu[row]![column]! * value[column]!;
  }
  for (let row = size - 1; row >= 0; row--) {
    for (let column = row + 1; column < size; column++) value[row]! -= lu[row]![column]! * value[column]!;
    value[row]! /= lu[row]![row]!;
  }
  return value;
}

function tpsClosedForm(fit: GeoFit, valid: readonly { anchor: Anchor; index: number }[]): Record<string, number> | null {
  if (fit.method !== 'tps' || fit.model.kind !== 'tps' || valid.length < 5) return null;
  const { controls, weightsE, weightsN } = fit.model;
  if (controls.length !== valid.length) return null;
  const n = controls.length;
  const size = n + 3;
  const matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let i = 0; i < n; i++) {
    const [u, v] = controls[i]!;
    for (let j = 0; j < n; j++) {
      const [cu, cv] = controls[j]!;
      matrix[i]![j] = kernel((u - cu) ** 2 + (v - cv) ** 2);
    }
    matrix[i]![n] = matrix[n]![i] = 1;
    matrix[i]![n + 1] = matrix[n + 1]![i] = u;
    matrix[i]![n + 2] = matrix[n + 2]![i] = v;
  }
  const factored = factor(matrix);
  if (!factored) return null;
  const residuals: Record<string, number> = {};
  const rhs = new Array<number>(size).fill(0);
  for (let i = 0; i < n; i++) {
    rhs.fill(0);
    rhs[i] = 1;
    const inverseColumn = solveFactored(factored.lu, factored.permutation, rhs);
    const diagonal = inverseColumn[i]!;
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-15) return null;
    const anchor = valid[i]!.anchor;
    const predicted: LatLon = [
      anchor.ll![0] - (weightsN[i]! / diagonal) / fit.frame.ky,
      anchor.ll![1] - (weightsE[i]! / diagonal) / fit.frame.kx,
    ];
    residuals[anchor.id] = haversine(anchor.ll as LatLon, predicted);
  }
  return residuals;
}

/** M2: predict each anchor from a fit excluding that anchor. */
export function withLooResiduals(
  fit: GeoFit,
  anchors: readonly Anchor[],
  width: number,
  height: number,
): GeoFit {
  const valid = anchors
    .map((anchor, index) => ({ anchor, index }))
    .filter(
      ({ anchor }) =>
        anchor.ll !== null &&
        Number.isFinite(anchor.ll[0]) &&
        Number.isFinite(anchor.ll[1]) &&
        Number.isFinite(anchor.px[0]) &&
        Number.isFinite(anchor.px[1]),
    );
  const looResiduals: Record<string, number> = {};

  const closedForm = tpsClosedForm(fit, valid);
  if (closedForm) return { ...fit, looResiduals: closedForm };

  for (const { anchor, index } of valid) {
    const others = anchors.filter((_, otherIndex) => otherIndex !== index);
    const looFit = fitAnchors(others, width, height, fit.requested);
    if (!looFit.ok) continue;
    looResiduals[anchor.id] = haversine(
      anchor.ll as LatLon,
      forward(looFit, anchor.px),
    );
  }

  return { ...fit, looResiduals };
}

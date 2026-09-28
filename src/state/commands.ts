// Lane B. One factory per undoable edit (card T-201). Ports the prototype's edits in
// reference/trailmaker-prototype.html, replacing its JSON snapshot `commit()` with commands.
//
// Every factory takes the current Project first and captures, at creation time, all it needs:
// new ids (prototype `uid`: prefix + seq), the timestamp and the before/after value of the one
// entity it touches. apply/revert are then pure functions of their input: they never read a
// clock, touch only that entity plus seq/updatedAt, and leave every other array reference
// alone (the fit memo in store.ts relies on that).
import type {
  Anchor,
  AnchorId,
  AnchorSource,
  AutoTraceSettings,
  ChipId,
  ColorChip,
  Feature,
  FeatureId,
  FitMethod,
  HexColor,
  HistoryCommand,
  LatLon,
  PoiType,
  Project,
  Px,
  Rgb,
  TopologyEdit,
  TraceSettings,
  Units,
} from '../core/types';

/** An edit the prototype refuses with a message instead of applying. */
export interface EditRefusal {
  /** User-visible explanation (shown as a toast). */
  readonly error: string;
}

/** A command that creates something, with the id(s) it will create. */
export interface CreateResult<Id> {
  readonly command: HistoryCommand;
  readonly id: Id;
}

/** A Feature without its id, as passed to addFeature. */
export type NewFeature = Feature extends infer F
  ? F extends unknown
    ? Omit<F, 'id'>
    : never
  : never;

/** A trail accepted from auto-trace review. */
export interface AcceptedTrail {
  readonly name: string;
  readonly color: HexColor;
  readonly pts: readonly Px[];
  readonly ink: Rgb | null;
  /** T-210: notes for a merged candidate, listing the other colors it absorbed. */
  readonly notes?: string;
}

/** Editable fields of a feature. poiType applies to POIs only. */
export interface FeatureFields {
  readonly name?: string;
  readonly color?: HexColor;
  readonly notes?: string;
  readonly poiType?: PoiType;
}

/** Editable fields of a color chip. */
export interface ChipFields {
  readonly name?: string;
  readonly enabled?: boolean;
  /** Set when the user types a name (candidates are then named "Name (part n)"). */
  readonly named?: boolean;
}

/** A color to add as an auto-trace chip. */
export interface NewChip {
  readonly rgb: Rgb;
  readonly name: string;
  readonly enabled: boolean;
  readonly share: number | null;
  /** Name came from the user or a legend: renames a near-duplicate chip (prototype `fromLegend`). */
  readonly named: boolean;
}

/** Chips closer than this in RGB are the same ink (prototype addChip). */
export const CHIP_MERGE_DISTANCE = 40;

type Edit = (p: Project) => Project;

// The project each command was built from. A command applied to any other project would write
// stale seq/updatedAt values, so store.edit refuses it (see baseOf).
const bases = new WeakMap<HistoryCommand, Project>();

/** The project a factory built this command from, or undefined for foreign commands. */
export function baseOf(cmd: HistoryCommand): Project | undefined {
  return bases.get(cmd);
}

function makeCommand(
  p: Project,
  label: string,
  coalesceKey: string | null,
  forward: Edit,
  backward: Edit,
  idsUsed = 0,
): HistoryCommand {
  const before = { seq: p.seq, updatedAt: p.updatedAt };
  const after = { seq: p.seq + idsUsed, updatedAt: new Date().toISOString() };
  const command: HistoryCommand = {
    label,
    coalesceKey,
    apply: (q) => ({ ...forward(q), ...after }),
    revert: (q) => ({ ...backward(q), ...before }),
  };
  bases.set(command, p);
  return command;
}

function indexById<T extends { readonly id: string }>(
  list: readonly T[],
  id: string,
  what: string,
): number {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`${what} ${id} not found`);
  return i;
}

function replaceById<T extends { readonly id: string }>(list: readonly T[], item: T): T[] {
  return list.map((x) => (x.id === item.id ? item : x));
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  return [...list.slice(0, index), item, ...list.slice(index)];
}

function withoutId<T extends { readonly id: string }>(list: readonly T[], id: string): T[] {
  return list.filter((x) => x.id !== id);
}

/* ---------------------------------------------------------------- generic entity edits */

function replaceAnchor(
  p: Project,
  label: string,
  key: string | null,
  next: Anchor,
): HistoryCommand {
  const prev = p.anchors[indexById(p.anchors, next.id, 'Anchor')]!;
  return makeCommand(
    p,
    label,
    key,
    (q) => ({ ...q, anchors: replaceById(q.anchors, next) }),
    (q) => ({ ...q, anchors: replaceById(q.anchors, prev) }),
  );
}

function replaceFeature(
  p: Project,
  label: string,
  key: string | null,
  next: Feature,
): HistoryCommand {
  const prev = p.features[indexById(p.features, next.id, 'Feature')]!;
  return makeCommand(
    p,
    label,
    key,
    (q) => ({ ...q, features: replaceById(q.features, next) }),
    (q) => ({ ...q, features: replaceById(q.features, prev) }),
  );
}

function setField<K extends 'name' | 'fitMethod' | 'units' | 'trace' | 'autoTrace'>(
  p: Project,
  label: string,
  key: string | null,
  field: K,
  value: Project[K],
): HistoryCommand {
  const prev = p[field];
  return makeCommand(
    p,
    label,
    key,
    (q) => ({ ...q, [field]: value }),
    (q) => ({ ...q, [field]: prev }),
  );
}

function fieldKeys(fields: object): string {
  return Object.keys(fields).sort().join(',');
}

/* ---------------------------------------------------------------- anchors */

/** Drop a new anchor pin at px, coordinates not yet entered (prototype gcp tool). */
export function addAnchor(p: Project, px: Px): CreateResult<AnchorId> {
  const anchor: Anchor = { id: `g${p.seq}`, px, ll: null, source: 'paste' };
  const command = makeCommand(
    p,
    'Add anchor',
    null,
    (q) => ({ ...q, anchors: [...q.anchors, anchor] }),
    (q) => ({ ...q, anchors: withoutId(q.anchors, anchor.id) }),
    1,
  );
  return { command, id: anchor.id };
}

/** Move an anchor pin. Consecutive moves of the same anchor coalesce until the history is sealed. */
export function moveAnchor(p: Project, id: AnchorId, px: Px): HistoryCommand {
  const a = p.anchors[indexById(p.anchors, id, 'Anchor')]!;
  return replaceAnchor(p, 'Move anchor', `move-anchor:${id}`, { ...a, px });
}

/** Set (or clear, with null) an anchor's real-world position. */
export function setAnchorCoords(
  p: Project,
  id: AnchorId,
  ll: LatLon | null,
  source: AnchorSource = 'paste',
): HistoryCommand {
  const a = p.anchors[indexById(p.anchors, id, 'Anchor')]!;
  return replaceAnchor(p, 'Set anchor coordinates', null, { ...a, ll, source });
}

/** Remove an anchor; undo restores it at its original position in the list. */
export function removeAnchor(p: Project, id: AnchorId): HistoryCommand {
  const index = indexById(p.anchors, id, 'Anchor');
  const anchor = p.anchors[index]!;
  return makeCommand(
    p,
    'Remove anchor',
    null,
    (q) => ({ ...q, anchors: withoutId(q.anchors, id) }),
    (q) => ({ ...q, anchors: insertAt(q.anchors, index, anchor) }),
  );
}

/** Choose the fit method. */
export function setFitMethod(p: Project, method: FitMethod): HistoryCommand {
  return setField(p, 'Change fit method', null, 'fitMethod', method);
}

/* ---------------------------------------------------------------- features */

/** Add a finished trail, area or POI. */
export function addFeature(p: Project, spec: NewFeature): CreateResult<FeatureId> {
  const feature = { ...spec, id: `f${p.seq}` } as Feature;
  const label =
    feature.kind === 'poi' ? 'Add point' : feature.kind === 'area' ? 'Add area' : 'Add trail';
  const command = makeCommand(
    p,
    label,
    null,
    (q) => ({ ...q, features: [...q.features, feature] }),
    (q) => ({ ...q, features: withoutId(q.features, feature.id) }),
    1,
  );
  return { command, id: feature.id };
}

/**
 * Edit name/color/notes (and poiType for POIs). Consecutive edits of the same fields of the
 * same feature coalesce, so typing a name is one undo step.
 */
export function updateFeature(p: Project, id: FeatureId, fields: FeatureFields): HistoryCommand {
  const f = p.features[indexById(p.features, id, 'Feature')]!;
  if (fields.poiType !== undefined && f.kind !== 'poi')
    throw new Error(`Feature ${id} is not a point`);
  const next = { ...f, ...fields } as Feature;
  return replaceFeature(p, 'Edit feature', `feature:${id}:${fieldKeys(fields)}`, next);
}

/**
 * Move vertex `index` of a trail or area (index 0 of a POI moves the point). Consecutive moves
 * of the same vertex coalesce until the history is sealed (the editor seals on pointer up).
 */
export function moveVertex(p: Project, id: FeatureId, index: number, to: Px): HistoryCommand {
  const f = p.features[indexById(p.features, id, 'Feature')]!;
  const key = `move-vertex:${id}:${index}`;
  if (f.kind === 'poi') {
    if (index !== 0) throw new Error(`Point ${id} has only vertex 0`);
    return replaceFeature(p, 'Move point', key, { ...f, at: to });
  }
  if (index < 0 || index >= f.pts.length) throw new Error(`Vertex ${index} out of range for ${id}`);
  const pts = f.pts.map((pt, i) => (i === index ? to : pt));
  return replaceFeature(p, 'Move vertex', key, { ...f, pts });
}

/** Delete one vertex. Refused (prototype message) when it would leave a trail < 2 or an area < 3 points. */
export function deleteVertex(
  p: Project,
  id: FeatureId,
  index: number,
): HistoryCommand | EditRefusal {
  const f = p.features[indexById(p.features, id, 'Feature')]!;
  if (f.kind === 'poi') throw new Error(`Point ${id} has no vertices to delete`);
  if (index < 0 || index >= f.pts.length) throw new Error(`Vertex ${index} out of range for ${id}`);
  const min = f.kind === 'area' ? 3 : 2;
  if (f.pts.length <= min) {
    const article = f.kind === 'area' ? 'An' : 'A';
    return {
      error: `${article} ${f.kind} needs at least ${min} points. Delete it from the sidebar instead.`,
    };
  }
  const pts = f.pts.filter((_, i) => i !== index);
  return replaceFeature(p, 'Delete vertex', null, { ...f, pts });
}

/** Replace a trail's points and ink (prototype "continue trail" finishing onto an existing trail). */
export function replaceTrailPoints(
  p: Project,
  id: FeatureId,
  pts: readonly Px[],
  ink: Rgb | null,
): HistoryCommand {
  const f = p.features[indexById(p.features, id, 'Feature')]!;
  if (f.kind !== 'trail') throw new Error(`Feature ${id} is not a trail`);
  if (pts.length < 2) throw new Error('A trail needs at least 2 points.');
  return replaceFeature(p, 'Continue trail', null, { ...f, pts, ink });
}

/** Reverse a trail's direction. */
export function reverseTrail(p: Project, id: FeatureId): HistoryCommand {
  const f = p.features[indexById(p.features, id, 'Feature')]!;
  if (f.kind !== 'trail') throw new Error(`Feature ${id} is not a trail`);
  return replaceFeature(p, 'Reverse trail', null, { ...f, pts: [...f.pts].reverse() });
}

/** Delete a feature; undo restores it at its original position in the list. */
export function deleteFeature(p: Project, id: FeatureId): HistoryCommand {
  const index = indexById(p.features, id, 'Feature');
  const feature = p.features[index]!;
  return makeCommand(
    p,
    `Delete ${feature.kind === 'poi' ? 'point' : feature.kind}`,
    null,
    (q) => ({ ...q, features: withoutId(q.features, id) }),
    (q) => ({ ...q, features: insertAt(q.features, index, feature) }),
  );
}

/** Add accepted auto-trace candidates as trails, all in one undo step. */
export function acceptCandidates(
  p: Project,
  trails: readonly AcceptedTrail[],
): CreateResult<FeatureId[]> {
  if (!trails.length) throw new Error('No candidates to accept');
  const added: Feature[] = trails.map((t, k) => ({
    kind: 'trail',
    id: `f${p.seq + k}`,
    name: t.name,
    color: t.color,
    notes: t.notes ?? '',
    pts: t.pts,
    ink: t.ink,
  }));
  const ids = new Set(added.map((f) => f.id));
  const command = makeCommand(
    p,
    trails.length === 1 ? 'Add trail' : `Add ${trails.length} trails`,
    null,
    (q) => ({ ...q, features: [...q.features, ...added] }),
    (q) => ({ ...q, features: q.features.filter((f) => !ids.has(f.id)) }),
    added.length,
  );
  return { command, id: added.map((f) => f.id) };
}

/* ---------------------------------------------------------------- topology (T-209) */

/**
 * Apply a topology edit (split, join, or snapTrailEnds' cleanup) as one undo step: features
 * named in `removed` disappear, and each feature in `updated` replaces its id if the id already
 * exists, or is inserted right after the feature it was built from otherwise (splitTrail's new
 * second half lands next to the original, not at the end of the list). The revert snapshots
 * `p.features` directly, so it is exact by construction.
 */
export function applyTopologyEdit(p: Project, e: TopologyEdit): HistoryCommand {
  const prevFeatures = p.features;
  let features = prevFeatures.filter((f) => !e.removed.includes(f.id));
  let insertAfter = -1;
  for (const u of e.updated) {
    const index = features.findIndex((f) => f.id === u.id);
    if (index >= 0) {
      features = replaceById(features, u);
      insertAfter = index;
    } else {
      insertAfter += 1;
      features = insertAt(features, insertAfter, u);
    }
  }
  const newIds = e.updated.filter((u) => !prevFeatures.some((f) => f.id === u.id)).length;
  const label = e.removed.length ? 'Join trails' : newIds > 0 ? 'Split trail' : 'Clean up junctions';
  return makeCommand(
    p,
    label,
    null,
    (q) => ({ ...q, features }),
    (q) => ({ ...q, features: prevFeatures }),
    newIds,
  );
}

/* ---------------------------------------------------------------- settings */

/** Rename the project (export document name). Consecutive edits coalesce, so typing is one step. */
export function setProjectName(p: Project, name: string): HistoryCommand {
  return setField(p, 'Rename map', 'project-name', 'name', name);
}

/** Switch display/export units. */
export function setUnits(p: Project, units: Units): HistoryCommand {
  return setField(p, 'Change units', null, 'units', units);
}

/** Change smart-follow settings. Consecutive changes of the same settings (slider drags) coalesce. */
export function setTraceSettings(p: Project, patch: Partial<TraceSettings>): HistoryCommand {
  return setField(p, 'Change trace settings', `trace:${fieldKeys(patch)}`, 'trace', {
    ...p.trace,
    ...patch,
  });
}

/** Change gap bridging / minimum length. Consecutive changes of the same settings coalesce. */
export function setAutoTraceSettings(
  p: Project,
  patch: Partial<Pick<AutoTraceSettings, 'gapPx' | 'minLengthPct'>>,
): HistoryCommand {
  return setField(p, 'Change auto-trace settings', `auto-trace:${fieldKeys(patch)}`, 'autoTrace', {
    ...p.autoTrace,
    ...patch,
  });
}

/* ---------------------------------------------------------------- color chips */

const rgbDistance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function setChips(
  p: Project,
  label: string,
  key: string | null,
  chips: readonly ColorChip[],
  idsUsed = 0,
) {
  const prev = p.autoTrace.chips;
  return makeCommand(
    p,
    label,
    key,
    (q) => ({ ...q, autoTrace: { ...q.autoTrace, chips } }),
    (q) => ({ ...q, autoTrace: { ...q.autoTrace, chips: prev } }),
    idsUsed,
  );
}

/**
 * Add auto-trace colors in one undo step (a scan adds several). Prototype addChip rule: a color
 * within CHIP_MERGE_DISTANCE of an existing chip is not added again; instead that chip is
 * enabled (if the new one is) and, for a named color, renamed. `ids` gives the chip each input
 * landed in; `command` is null when nothing would change.
 */
export function addChips(
  p: Project,
  specs: readonly NewChip[],
): { command: HistoryCommand | null; ids: ChipId[] } {
  const chips = [...p.autoTrace.chips];
  const ids: ChipId[] = [];
  let seq = p.seq;
  let changed = false;
  for (const spec of specs) {
    const k = chips.findIndex((c) => rgbDistance(c.rgb, spec.rgb) < CHIP_MERGE_DISTANCE);
    const near = chips[k];
    if (near) {
      ids.push(near.id);
      const next: ColorChip = {
        ...near,
        enabled: near.enabled || spec.enabled,
        ...(spec.named ? { name: spec.name, named: true } : {}),
      };
      if (next.enabled !== near.enabled || next.name !== near.name || next.named !== near.named) {
        chips[k] = next;
        changed = true;
      }
      continue;
    }
    const chip: ColorChip = {
      id: `c${seq++}`,
      rgb: [Math.round(spec.rgb[0]), Math.round(spec.rgb[1]), Math.round(spec.rgb[2])],
      name: spec.name,
      enabled: spec.enabled,
      share: spec.share,
      named: spec.named,
    };
    chips.push(chip);
    ids.push(chip.id);
    changed = true;
  }
  if (!changed) return { command: null, ids };
  const label = specs.length === 1 ? 'Add color' : 'Add colors';
  return { command: setChips(p, label, null, chips, seq - p.seq), ids };
}

/** Rename or toggle a chip. Consecutive edits of the same chip fields coalesce (typing a name). */
export function updateChip(p: Project, id: ChipId, fields: ChipFields): HistoryCommand {
  const chips = p.autoTrace.chips;
  const chip = chips[indexById(chips, id, 'Color')]!;
  const next = { ...chip, ...fields };
  return setChips(p, 'Edit color', `chip:${id}:${fieldKeys(fields)}`, replaceById(chips, next));
}

/** Remove a chip; undo restores it at its original position. */
export function removeChip(p: Project, id: ChipId): HistoryCommand {
  const chips = p.autoTrace.chips;
  indexById(chips, id, 'Color');
  return setChips(p, 'Remove color', null, withoutId(chips, id));
}

/** Type guard for deleteVertex's refusal. */
export function isRefusal(x: HistoryCommand | EditRefusal): x is EditRefusal {
  return 'error' in x;
}

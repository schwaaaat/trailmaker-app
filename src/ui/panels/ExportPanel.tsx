/** @jsxRuntime automatic */
// Lane B. Step 4 "Export" (card T-205): the prototype's renderExport, dlZip, single downloads and
// copy buttons. KMZ is built on the worker (T-106/T-207) with Lane C's overlay JPEG.
// Everything else runs on the main thread in <= 8 ms time slices (card T-211). At 2,000 x 50 a
// single GPX/KML/GeoJSON is 60-100 ms of work and "Download all" ~1 s. A busy overlay with Cancel
// appears once an export has run for BUSY_AFTER_MS.
import { useEffect, useState } from 'react';
import { exportZipSteps } from '../../core/export/bundle';
import { exportDocumentSteps } from '../../core/export/document';
import { formatLength, slugify } from '../../core/export/format';
import { geoJsonParts } from '../../core/export/geojson';
import { gpxParts } from '../../core/export/gpx';
import { kmlParts } from '../../core/export/kml';
import { overlayQuad } from '../../core/geo/fit';
import type {
  ExportDocument,
  ExportOptions,
  Feature,
  GeoFit,
  JobId,
  Project,
  Units,
} from '../../core/types';
import { downloadBlob } from '../../io/download';
import { encodeOverlayJpeg } from '../../io/overlay';
import { setUnits } from '../../state/commands';
import { useApp, useFit } from '../../state/hooks';
import { appStore, edit, selectFit, setBusy, showToast } from '../../state/store';
import { cleanupJunctions, cleanupTolerancePx, needsCleanup } from '../../state/topology-actions';
import {
  call,
  cancelJob,
  isCancelled,
  isReported,
  jobDone,
  startJob,
  track,
} from '../../state/worker-link';
import { currentEditor } from '../editor/EditorStage';
import { cancelledError, runSliced } from '../editor/slice';
import { SaveProjectButton } from '../files';
import { featureLengthM } from './lengths';

type Format = 'gpx' | 'kml' | 'kmz' | 'geojson' | 'zip';
type TextFormat = 'gpx' | 'kml' | 'geojson';

/** An export shows the busy overlay (with Cancel) once it has run this long, ms. */
export const BUSY_AFTER_MS = 150;
/** Edit idle time before the junction hint is evaluated, ms (D-020). */
export const HINT_IDLE_MS = 500;

/** The summary line above the export buttons (prototype renderExport). */
export function exportSummary(p: Project, fit: GeoFit | null): string {
  if (!fit) return 'Pin the map to at least 2 real-world coordinates first.';
  if (!p.features.length) return 'Trace at least one trail or point.';
  const trails = p.features.filter((f) => f.kind === 'trail');
  const areas = p.features.filter((f) => f.kind === 'area');
  const points = p.features.filter((f) => f.kind === 'poi');
  const total = trails.reduce((m, f) => m + featureLengthM(fit, f), 0);
  const parts: string[] = [];
  if (trails.length)
    parts.push(
      `${trails.length} trail${trails.length > 1 ? 's' : ''} (${formatLength(total, p.units)})`,
    );
  if (areas.length) parts.push(`${areas.length} area${areas.length > 1 ? 's' : ''}`);
  if (points.length) parts.push(`${points.length} point${points.length > 1 ? 's' : ''}`);
  return `Ready: ${parts.join(', ')}.`;
}

/**
 * One export run: its cancel flag, the worker job it may be waiting on, and a busy overlay that
 * appears only once the run has lasted BUSY_AFTER_MS, so small exports don't flash it.
 */
class ExportRun {
  private cancelled = false;
  private jobId: JobId | null = null;
  private shown = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private text: string) {
    this.timer = setTimeout(() => {
      this.shown = true;
      setBusy(this.text, this.cancel);
    }, BUSY_AFTER_MS);
  }

  /** The busy overlay's Cancel. */
  readonly cancel = (): void => {
    this.cancelled = true;
    if (this.jobId) void cancelJob(this.jobId);
  };

  /** Set the busy text (shown now if the overlay is up, otherwise when it appears). */
  stage(text: string): void {
    this.text = text;
    if (this.shown) setBusy(text, this.cancel);
  }

  /** Run step work in time slices; rejects with a JobCancelled error once cancelled. */
  sliced<T>(steps: Generator<unknown, T, undefined>): Promise<T> {
    return runSliced(steps, { cancelled: () => this.cancelled });
  }

  /** Throw the JobCancelled error if Cancel was pressed. */
  check(): void {
    if (this.cancelled) throw cancelledError();
  }

  /** The worker job this run is waiting on (Cancel cancels it), or null. */
  waitingOn(id: JobId | null): void {
    this.jobId = id;
  }

  end(): void {
    clearTimeout(this.timer);
    if (this.shown) setBusy(null);
  }
}

/** Collect a writer's parts, one step per part (a feature). */
function* collect(parts: Iterable<string>): Generator<void, string[], undefined> {
  const out: string[] = [];
  for (const part of parts) {
    out.push(part);
    yield;
  }
  return out;
}

const TEXT: Readonly<
  Record<
    TextFormat,
    { stage: string; parts: (doc: ExportDocument, opts: ExportOptions) => Iterable<string> }
  >
> = {
  gpx: { stage: 'Writing GPX…', parts: (doc, opts) => gpxParts(doc, opts) },
  kml: { stage: 'Writing KML…', parts: (doc, opts) => kmlParts(doc, opts, null) },
  geojson: { stage: 'Writing GeoJSON…', parts: (doc, opts) => geoJsonParts(doc, opts) },
};

const TYPES: Readonly<Record<Format, string>> = {
  gpx: 'application/gpx+xml',
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  geojson: 'application/geo+json',
  zip: 'application/zip',
};

interface Ready {
  readonly p: Project;
  readonly fit: GeoFit;
  readonly opts: ExportOptions;
}

/** The session's export inputs, or null when not ready (no fit or no features). */
function readyNow(): Ready | null {
  const s = appStore.getState();
  const p = s.session?.project;
  const fit = selectFit(s);
  if (!p || !fit?.ok || !p.features.length) return null;
  return { p, fit, opts: { units: p.units, time: new Date().toISOString() } };
}

/** Build a KMZ (with the map as a GroundOverlay) on the worker. */
async function buildKmzBytes(
  run: ExportRun,
  p: Project,
  fit: GeoFit,
  doc: ExportDocument,
  options: ExportOptions,
): Promise<Uint8Array> {
  const map = appStore.getState().session?.map;
  if (!map) throw new Error('No map is open');
  const bytes = await encodeOverlayJpeg(map);
  run.check();
  const quad = overlayQuad(fit, p.image.width, p.image.height);
  // The KML writer reads only lat/lon. Dropping the pixel paths halves the structured clone that
  // postMessage makes on this thread (~90 ms for the full document at 2,000 x 50).
  const lean: ExportDocument = {
    ...doc,
    features: doc.features.map((f) => (f.kind === 'poi' ? f : { ...f, pts: [] })),
  };
  const jobId = startJob(map);
  run.waitingOn(jobId);
  try {
    return await call((api) =>
      api.buildKmz({ doc: lean, options, overlayImage: { bytes, ext: 'jpg' }, quad }, { jobId }),
    );
  } finally {
    run.waitingOn(null);
    jobDone(jobId);
  }
}

function failed(err: unknown): void {
  if (!isCancelled(err) && !isReported(err)) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

/** Build and save one export (the prototype's download buttons). */
export function download(format: Format): Promise<void> {
  return track(
    (async () => {
      const ready = readyNow();
      if (!ready) return;
      const { p, fit, opts } = ready;
      const base = slugify(p.name);
      const run = new ExportRun('Preparing export…');
      try {
        const doc = await run.sliced(exportDocumentSteps(p, fit));
        if (format === 'gpx' || format === 'kml' || format === 'geojson') {
          run.stage(TEXT[format].stage);
          const parts = await run.sliced(collect(TEXT[format].parts(doc, opts)));
          await downloadBlob(`${base}.${format}`, new Blob(parts, { type: TYPES[format] }));
          return;
        }
        run.stage(format === 'kmz' ? 'Building KMZ…' : 'Building files…');
        const kmz = await buildKmzBytes(run, p, fit, doc, opts);
        run.check();
        if (format === 'kmz') {
          await downloadBlob(`${base}.kmz`, new Blob([kmz as BlobPart], { type: TYPES.kmz }));
        } else {
          const zip = await run.sliced(exportZipSteps(doc, opts, kmz));
          await downloadBlob(
            `${base}-trail-map.zip`,
            new Blob([zip as BlobPart], { type: TYPES.zip }),
          );
        }
      } catch (err) {
        failed(err);
      } finally {
        run.end();
      }
    })(),
  );
}

/** Copy through a hidden textarea (the prototype's fallback). */
function copyWithTextarea(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Copy GPX or KML text to the clipboard (prototype copyText). */
export function copyExport(format: 'gpx' | 'kml'): Promise<void> {
  const ready = readyNow();
  if (!ready) return Promise.resolve();
  const { p, fit, opts } = ready;
  const run = new ExportRun(TEXT[format].stage);
  const text = track(
    (async () => {
      try {
        const doc = await run.sliced(exportDocumentSteps(p, fit));
        return (await run.sliced(collect(TEXT[format].parts(doc, opts)))).join('');
      } finally {
        run.end();
      }
    })(),
  );
  const what = format.toUpperCase();
  return (async () => {
    let ok = false;
    try {
      // The text is built over several tasks. Handing the clipboard a promise keeps this click's
      // user activation, which Safari requires; Chromium also accepts a later writeText.
      if (
        typeof ClipboardItem !== 'undefined' &&
        typeof navigator.clipboard?.write === 'function'
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      ok = true;
    } catch {
      const t = await text.catch((e: unknown) => {
        failed(e);
        return null;
      });
      if (t === null) return;
      ok = copyWithTextarea(t);
    }
    showToast(
      ok
        ? `${what} copied. Paste it into a text file and save it with the .${format} extension.`
        : 'Copying was blocked here. Use the .zip download instead.',
      5200,
    );
  })();
}

function UnitsGroup() {
  const units = useApp((s) => s.session?.project.units ?? 'mi');
  const choose = (u: Units) => {
    const p = appStore.getState().session?.project;
    if (p && p.units !== u) edit(setUnits(p, u));
  };
  return (
    <div className="row units-row">
      <span className="hint">Distances in</span>
      <span className="seg" role="group" aria-label="Export units">
        {(['mi', 'km'] as const).map((u) => (
          <button key={u} type="button" aria-pressed={units === u} onClick={() => choose(u)}>
            {u === 'mi' ? 'miles' : 'km'}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * Non-blocking hint (T-209 acceptance 5): some trail ends are close enough to another trail that
 * "Clean up junctions" would join them, but the export hasn't been asked to. Exports are never
 * modified silently, so this only offers the same button step 3 has, at the same tolerance.
 * The check (T-112's detector) exits early when an end is unsnapped but costs ~75-120 ms at
 * 2,000 x 50 when every end is clean, so it runs only after edits have been idle HINT_IDLE_MS,
 * never during a drag or with a draft open, and the hint shows only for the features it was
 * computed on (D-020).
 */
function JunctionHint() {
  const features = useApp((s) => s.session?.project.features ?? null);
  const drafting = useApp((s) => s.draft !== null);
  const [found, setFound] = useState<{
    features: readonly Feature[];
    tolerancePx: number;
  } | null>(null);
  useEffect(() => {
    if (!features || drafting) return;
    let timer = setTimeout(function check() {
      if (currentEditor()?.pressing) {
        timer = setTimeout(check, HINT_IDLE_MS);
        return;
      }
      const tolerancePx = cleanupTolerancePx(currentEditor()?.view.s ?? 1);
      setFound(needsCleanup(features, tolerancePx) ? { features, tolerancePx } : null);
    }, HINT_IDLE_MS);
    return () => clearTimeout(timer);
  }, [features, drafting]);
  if (!found || found.features !== features) return null;
  const { tolerancePx } = found;
  return (
    <p className="hint warn">
      Some trail ends are close but not joined.{' '}
      <button type="button" className="btn small" onClick={() => cleanupJunctions(tolerancePx)}>
        Clean up junctions
      </button>
    </p>
  );
}

export function ExportPanel() {
  const project = useApp((s) => s.session?.project ?? null);
  const fit = useFit();
  if (!project) return null;
  const okFit = fit?.ok ? fit : null;
  const ready = okFit !== null && project.features.length > 0;
  return (
    <div className="export-panel">
      <p className="sum">{exportSummary(project, okFit)}</p>
      <JunctionHint />
      <UnitsGroup />
      <div className="stack">
        <button
          type="button"
          className="btn primary wide"
          disabled={!ready}
          onClick={() => void download('zip')}
        >
          Download all (.zip)
        </button>
        <div className="row">
          <button
            type="button"
            className="btn small"
            aria-label="Download GPX"
            disabled={!ready}
            onClick={() => void download('gpx')}
          >
            GPX
          </button>
          <button
            type="button"
            className="btn small"
            aria-label="Download KML"
            disabled={!ready}
            onClick={() => void download('kml')}
          >
            KML
          </button>
          <button
            type="button"
            className="btn small"
            aria-label="Download KMZ with map overlay"
            disabled={!ready}
            onClick={() => void download('kmz')}
          >
            KMZ with map overlay
          </button>
          <button
            type="button"
            className="btn small"
            aria-label="Download GeoJSON"
            disabled={!ready}
            onClick={() => void download('geojson')}
          >
            GeoJSON
          </button>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn small"
            disabled={!ready}
            onClick={() => void copyExport('gpx')}
          >
            Copy GPX
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!ready}
            onClick={() => void copyExport('kml')}
          >
            Copy KML
          </button>
        </div>
      </div>
      <p className="fine">
        GPX works in Gaia GPS, AllTrails, CalTopo, OsmAnd and Garmin. KML opens in Google Earth and
        Google My Maps. The KMZ also carries your original map as an overlay.
      </p>
      <div className="row save-row">
        <SaveProjectButton className="btn small" />
      </div>
    </div>
  );
}

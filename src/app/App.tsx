/** @jsxRuntime automatic */
// Lane B. Root layout (card T-203): header, the four steps, the editor stage and overlays.
// Step contents are mounted by their cards (T-205 panels, T-304 file UI; D-006). The
// georeferencing split (T-212) mounts Lane C's BasemapPane/OverlayPreview/BasemapConsent;
// Lane B owns the layout, divider and toggle around them (D-006, D-018).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Units } from '../core/types';
import { type AppSettings, loadSettings, subscribeSettings, updateBasemapSettings } from '../io/settings';
import { sessionBridge } from '../state/bridge';
import { setProjectName, setUnits } from '../state/commands';
import { useApp } from '../state/hooks';
import { appStore, edit, sealHistory, selectFit } from '../state/store';
import { installTestHook } from '../state/test-hook';
import { linkWorkerToSession } from '../state/worker-link';
import { EditorStage } from '../ui/editor/EditorStage';
import { TipLine, Toolbar } from '../ui/editor/Toolbar';
import {
  EmptyState,
  MapDropZone,
  OpenMapButton,
  OpenProjectButton,
  PdfPagePicker,
  usePasteToOpen,
} from '../ui/files';
import { AnchorsPanel } from '../ui/panels/AnchorsPanel';
import { ExportPanel } from '../ui/panels/ExportPanel';
import { FeaturesPanel } from '../ui/panels/FeaturesPanel';
import { TracePanel } from '../ui/panels/TracePanel';
import { BasemapConsent, BasemapPane, OverlayPreview, type BasemapHandle } from '../ui/georef';
import { Divider } from './Divider';
import { HelpDialog } from './HelpDialog';
import { Busy, LiveRegion, Toast } from './Overlays';
import { loadSplitLayout, saveSplitLayout, useNarrowViewport, type PaneMode } from './splitLayout';
import './app.css';

installTestHook({ session: sessionBridge });

const currentProject = () => appStore.getState().session?.project ?? null;

function MapName() {
  const name = useApp((s) => s.session?.project.name ?? '');
  const open = useApp((s) => s.session !== null);
  return (
    <label className="map-name">
      <span>Map name</span>
      <input
        value={name}
        disabled={!open}
        placeholder="e.g. Red Reef Park trails"
        autoComplete="off"
        onChange={(e) => {
          const p = currentProject();
          if (p) edit(setProjectName(p, e.target.value));
        }}
        onBlur={sealHistory}
      />
    </label>
  );
}

function UnitsToggle() {
  const units = useApp((s) => s.session?.project.units ?? null);
  const choose = (u: Units) => {
    const p = currentProject();
    if (p && p.units !== u) edit(setUnits(p, u));
  };
  return (
    <span className="seg" role="group" aria-label="Distance units">
      {(['mi', 'km'] as const).map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={units === u}
          disabled={units === null}
          onClick={() => choose(u)}
        >
          {u === 'mi' ? 'miles' : 'km'}
        </button>
      ))}
    </span>
  );
}

/** "Show basemap" control (T-212): disabled with a reachable tooltip until Lane C's basemap
 * network opt-in is accepted; Lane C's own consent card (D-018) is what grants it. */
function GeorefToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => subscribeSettings(setSettings), []);
  const enabled = settings.basemap.enabled;
  const hintId = useId();
  return (
    <div className="georef-toggle">
      {!enabled && (
        <BasemapConsent
          styleUrl={settings.basemap.styleUrl}
          onEnable={() => updateBasemapSettings({ enabled: true })}
          onDismiss={() => setDismissed(true)}
          isDismissed={dismissed}
        />
      )}
      <button
        type="button"
        className="btn small"
        aria-pressed={show}
        aria-disabled={!enabled}
        aria-describedby={enabled ? undefined : hintId}
        onClick={() => {
          if (enabled) onToggle();
        }}
      >
        {show ? 'Hide basemap' : 'Show basemap'}
      </button>
      {!enabled && (
        <p id={hintId} className="hint">
          Accept the live basemap above to enable this.
        </p>
      )}
    </div>
  );
}

type StepState = 'locked' | 'done' | null;

function Step({
  n,
  title,
  state = null,
  children,
}: {
  n: number;
  title: string;
  state?: StepState;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={state ? `step ${state}` : 'step'} aria-labelledby={id}>
      <h2 id={id}>
        <span className="n" aria-hidden="true">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Locked/done states of the four steps (prototype renderSteps). */
function useStepStates(): [StepState, StepState, StepState, StepState] {
  const hasMap = useApp((s) => s.session !== null);
  const placed = useApp((s) => selectFit(s)?.ok === true);
  const traced = useApp((s) => (s.session?.project.features.length ?? 0) > 0);
  return [
    hasMap ? 'done' : null,
    !hasMap ? 'locked' : placed ? 'done' : null,
    !hasMap ? 'locked' : traced ? 'done' : null,
    placed && traced ? null : 'locked',
  ];
}

export default function App() {
  // Each opened map's raster goes to the worker once (T-206).
  useEffect(() => linkWorkerToSession(), []);
  // Pasting an image opens it as the map when nothing is open (Lane C, T-304).
  usePasteToOpen();
  const [s1, s2, s3, s4] = useStepStates();
  const fitOk = useApp((s) => selectFit(s)?.ok === true);
  const narrow = useNarrowViewport();
  const [layout, setLayout] = useState(loadSplitLayout);
  const stageRef = useRef<HTMLElement | null>(null);
  const basemapRef = useRef<BasemapHandle | null>(null);
  const overlayRef = useRef<BasemapHandle | null>(null);

  useEffect(() => saveSplitLayout(layout), [layout]);

  // Overlay preview only makes sense once the fit is ok (acceptance 3); fall back if it isn't.
  useEffect(() => {
    if (layout.mode === 'overlay' && !fitOk) setLayout((s) => ({ ...s, mode: 'pair' }));
  }, [layout.mode, fitOk]);

  const setShow = (show: boolean) => setLayout((s) => ({ ...s, show }));
  const setMode = (mode: PaneMode) => setLayout((s) => ({ ...s, mode }));
  const setFrac = (frac: number) => setLayout((s) => ({ ...s, frac }));
  // MapLibre doesn't observe its container; the divider commit has to nudge it (acceptance 4).
  const resizeBasemaps = () => {
    basemapRef.current?.getMap()?.resize();
    overlayRef.current?.getMap()?.resize();
  };

  return (
    <div className="app">
      <LiveRegion />
      <HelpDialog />
      <header className="app-header">
        <h1>Trailmaker</h1>
        <MapName />
        <UnitsToggle />
      </header>
      <aside className="side" aria-label="Steps">
        <Step n={1} title="Open map" state={s1}>
          <p className="hint">
            A photo, scan, screenshot or PDF of the trail map. Straight-on scans trace best.
          </p>
          <div className="row">
            <OpenMapButton className="btn primary" />
            <OpenProjectButton className="btn small" />
          </div>
          <PdfPagePicker />
        </Step>
        <Step n={2} title="Pin to real world" state={s2}>
          <AnchorsPanel />
          <GeorefToggle show={layout.show} onToggle={() => setShow(!layout.show)} />
        </Step>
        <Step n={3} title="Trace" state={s3}>
          <TracePanel />
          <FeaturesPanel />
        </Step>
        <Step n={4} title="Export" state={s4}>
          <ExportPanel />
        </Step>
      </aside>
      <main
        className={`stage${layout.show ? ' split' : ''}${narrow ? ' narrow' : ''}`}
        aria-label="Map"
        ref={stageRef}
      >
        <div
          className="stage-editor"
          role="region"
          aria-label="Park map"
          style={layout.show ? { flexBasis: `${layout.frac * 100}%` } : undefined}
        >
          <MapDropZone>
            <EditorStage />
            <EmptyState />
          </MapDropZone>
          <Toolbar />
          <TipLine />
          <Toast />
          <Busy />
        </div>
        {layout.show && (
          <>
            <Divider
              frac={layout.frac}
              orientation={narrow ? 'horizontal' : 'vertical'}
              onChange={setFrac}
              onCommit={(frac) => {
                setFrac(frac);
                resizeBasemaps();
              }}
              containerRef={stageRef}
            />
            <div className="stage-georef">
              <div className="seg" role="group" aria-label="Basemap view">
                <button
                  type="button"
                  aria-pressed={layout.mode === 'pair'}
                  onClick={() => setMode('pair')}
                >
                  Pair anchors
                </button>
                <button
                  type="button"
                  aria-pressed={layout.mode === 'overlay'}
                  disabled={!fitOk}
                  title={fitOk ? undefined : 'Pin at least 2 anchors first'}
                  onClick={() => setMode('overlay')}
                >
                  Overlay preview
                </button>
              </div>
              {layout.mode === 'pair' ? (
                <BasemapPane handleRef={basemapRef} />
              ) : (
                <OverlayPreview handleRef={overlayRef} />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

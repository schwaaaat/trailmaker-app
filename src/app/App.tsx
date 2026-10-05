/** @jsxRuntime automatic */
// Lane B. Root layout (card T-203): header, the four steps, the editor stage and overlays.
// Step contents are mounted by their cards (T-205 panels, T-304 file UI; D-006). The
// georeferencing split (T-212) mounts Lane C's BasemapPane/OverlayPreview/BasemapConsent;
// Lane B owns the layout, divider and toggle around them (D-006, D-018).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Units } from '../core/types';
import {
  type AppSettings,
  loadSettings,
  subscribeSettings,
  updateBasemapSettings,
} from '../io/settings';
import { sessionBridge } from '../state/bridge';
import { setProjectName, setUnits } from '../state/commands';
import { useApp } from '../state/hooks';
import { appStore, edit, sealHistory, selectFit, setStageView } from '../state/store';
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
  StartSatelliteButton,
  usePasteToOpen,
} from '../ui/files';
import { AnchorsPanel } from '../ui/panels/AnchorsPanel';
import { ExportPanel } from '../ui/panels/ExportPanel';
import { FeaturesPanel } from '../ui/panels/FeaturesPanel';
import { ConnectPanel } from '../ui/panels/ConnectPanel';
import { TracePanel } from '../ui/panels/TracePanel';
import {
  BasemapConsent,
  BasemapPane,
  getPairingState,
  OverlayPreview,
  type BasemapHandle,
} from '../ui/georef';
import { Divider } from './Divider';
import { HelpDialog } from './HelpDialog';
import { Busy, LiveRegion, Toast } from './Overlays';
import { resetInterface } from './resetInterface';
import {
  loadSplitLayout,
  saveSplitLayout,
  subscribeSplitLayout,
  useNarrowViewport,
  type PaneMode,
  type StageMode,
} from './splitLayout';
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
  useEffect(() => {
    return subscribeSettings((next) => {
      setSettings(next);
      if (!next.basemap.enabled) {
        setDismissed(false);
      }
    });
  }, []);
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
    <section className={state ? `step ${state}` : 'step'} aria-labelledby={id} data-step={n}>
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
  const hasMap = useApp((s) => s.session !== null);
  const fitOk = useApp((s) => selectFit(s)?.ok === true);
  const stageView = useApp((s) => s.stageView ?? 'map');
  const satelliteCaptureRequested = useApp((s) => s.satelliteCaptureRequested);
  const narrow = useNarrowViewport();
  const phoneLayout = useNarrowViewport('(max-width: 820px)');
  const [layout, setLayout] = useState(loadSplitLayout);
  const desktopTabs = !phoneLayout && layout.stageMode === 'tabs';
  const showStageTabs = layout.show && (phoneLayout || desktopTabs);
  const showOverlay =
    phoneLayout || desktopTabs ? stageView === 'overlay' : layout.mode === 'overlay';
  const stageRef = useRef<HTMLElement | null>(null);
  const basemapRef = useRef<BasemapHandle | null>(null);
  const overlayRef = useRef<BasemapHandle | null>(null);

  useEffect(() => subscribeSplitLayout(setLayout), []);
  useEffect(() => saveSplitLayout(layout), [layout]);

  // In desktop Tabs mode, switch tabs for pairing only when the user already has the basemap open.
  useEffect(() => {
    if (phoneLayout || layout.stageMode !== 'tabs') return;
    let previous = getPairingState(appStore.getState()).status;
    let switchedToBasemapForPair = false;
    if (
      previous === 'pending' &&
      layout.show &&
      (appStore.getState().stageView ?? 'map') === 'map'
    ) {
      switchedToBasemapForPair = true;
      setStageView('basemap');
    }
    return appStore.subscribe((state) => {
      const current = getPairingState(state).status;
      const startedPairing = previous !== 'pending' && current === 'pending';
      const completedPairing = previous === 'pending' && current !== 'pending';
      previous = current;
      if (startedPairing && layout.show && (state.stageView ?? 'map') === 'map') {
        switchedToBasemapForPair = true;
        setStageView('basemap');
      }
      if (completedPairing) {
        if (switchedToBasemapForPair) setStageView('map');
        switchedToBasemapForPair = false;
      }
    });
  }, [phoneLayout, layout.stageMode, layout.show]);

  // Backslash has no editor action; '[' already steps focused vertices by ten.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (phoneLayout || event.key !== '\\' || event.altKey || event.ctrlKey || event.metaKey)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      event.preventDefault();
      setLayout((s) => ({ ...s, stepsCollapsed: !s.stepsCollapsed }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phoneLayout]);

  // Satellite capture request opens the basemap pane (and basemap tab on phones, T-318).
  useEffect(() => {
    if (satelliteCaptureRequested) {
      setLayout((s) => ({ ...s, show: true, mode: 'pair' }));
      setStageView('basemap');
    }
  }, [satelliteCaptureRequested]);

  // Opening a map should put its canvas in view on phones. The consent dialog's
  // initial focus can scroll a short viewport past the stage before this happens.
  useEffect(() => {
    if (!hasMap || !phoneLayout) return;
    const stage = stageRef.current;
    if (typeof stage?.scrollIntoView === 'function') stage.scrollIntoView({ block: 'start' });
  }, [hasMap, phoneLayout]);

  // Overlay preview only makes sense once the fit is ok (acceptance 3); fall back if it isn't.
  useEffect(() => {
    if (layout.mode === 'overlay' && !fitOk) setLayout((s) => ({ ...s, mode: 'pair' }));
  }, [layout.mode, fitOk]);

  useEffect(() => {
    if ((!phoneLayout && !desktopTabs) || stageView === 'map' || !layout.show) return;
    const frame = requestAnimationFrame(() => {
      basemapRef.current?.getMap()?.resize();
      overlayRef.current?.getMap()?.resize();
    });
    return () => cancelAnimationFrame(frame);
  }, [phoneLayout, desktopTabs, stageView, layout.show]);

  const setShow = (show: boolean) => setLayout((s) => ({ ...s, show }));
  const toggleBasemap = () => {
    const show = !layout.show;
    setShow(show);
    if (desktopTabs) setStageView(show ? 'basemap' : 'map');
  };
  const setMode = (mode: PaneMode) => setLayout((s) => ({ ...s, mode }));
  const setStageMode = (stageMode: StageMode) => {
    setLayout((s) => ({ ...s, stageMode }));
    if (stageMode === 'tabs' && getPairingState(appStore.getState()).status === 'pending') {
      setLayout((s) => ({ ...s, show: true, mode: 'pair' }));
      setStageView('basemap');
    }
  };
  const setFrac = (frac: number) => setLayout((s) => ({ ...s, frac }));
  const setStepsCollapsed = (stepsCollapsed: boolean) =>
    setLayout((s) => ({ ...s, stepsCollapsed }));
  const expandAtStep = (n: number) => {
    setStepsCollapsed(false);
    requestAnimationFrame(() => {
      const step = stageRef.current?.parentElement?.querySelector<HTMLElement>(
        `[data-step="${n}"]`,
      );
      step?.scrollIntoView?.({ block: 'start' });
    });
  };
  // MapLibre doesn't observe its container; the divider commit has to nudge it (acceptance 4).
  const resizeBasemaps = () => {
    basemapRef.current?.getMap()?.resize();
    overlayRef.current?.getMap()?.resize();
  };

  return (
    <div className={`app${!phoneLayout && layout.stepsCollapsed ? ' collapsed' : ''}`}>
      <LiveRegion />
      <HelpDialog />
      <header className="app-header">
        <h1>Trailmaker</h1>
        <MapName />
        <UnitsToggle />
      </header>
      <main
        className={`stage${layout.show && !desktopTabs ? ' split' : ''}${narrow ? ' narrow' : ''}`}
        aria-label="Map"
        ref={stageRef}
      >
        {layout.show && (
          <div className="stage-header">
            {!phoneLayout && (
              <div className="seg stage-mode" role="group" aria-label="Stage layout">
                <button
                  type="button"
                  aria-pressed={layout.stageMode === 'side-by-side'}
                  onClick={() => setStageMode('side-by-side')}
                >
                  Side by side
                </button>
                <button
                  type="button"
                  aria-pressed={layout.stageMode === 'tabs'}
                  onClick={() => setStageMode('tabs')}
                >
                  Tabs
                </button>
              </div>
            )}
            {showStageTabs && (
              <div className="stage-tabs" role="tablist" aria-label="Map stage view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={stageView === 'map'}
                  onClick={() => setStageView('map')}
                >
                  Map
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={stageView === 'basemap'}
                  onClick={() => {
                    setMode('pair');
                    setStageView('basemap');
                  }}
                >
                  Basemap
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={stageView === 'overlay'}
                  disabled={!fitOk}
                  onClick={() => {
                    setMode('overlay');
                    setStageView('overlay');
                  }}
                >
                  Overlay
                </button>
              </div>
            )}
          </div>
        )}
        <div className="stage-content">
          <div
            className="stage-editor"
            role="region"
            aria-label="Park map"
            hidden={showStageTabs && stageView !== 'map'}
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
              {!phoneLayout && !desktopTabs && (
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
              )}
              <div className="stage-georef" hidden={showStageTabs && stageView === 'map'}>
                {!phoneLayout && !desktopTabs && (
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
                )}
                {showOverlay ? (
                  <OverlayPreview handleRef={overlayRef} />
                ) : (
                  <BasemapPane handleRef={basemapRef} onResetInterface={resetInterface} />
                )}
              </div>
            </>
          )}
        </div>
      </main>
      <aside
        className={`side${!phoneLayout && layout.stepsCollapsed ? ' collapsed' : ''}`}
        aria-label="Steps"
      >
        {!phoneLayout && !layout.stepsCollapsed && (
          <div className="side-header">
            <h2>Steps</h2>
            <button
              type="button"
              className="side-collapse"
              aria-label="Collapse steps panel"
              aria-expanded="true"
              aria-keyshortcuts={'\\'}
              title="Collapse steps (backslash)"
              onClick={() => setStepsCollapsed(true)}
            >
              Collapse
            </button>
          </div>
        )}
        {!phoneLayout && layout.stepsCollapsed && (
          <nav className="steps-rail" aria-label="Steps">
            {(['Open map', 'Pin to real world', 'Trace', 'Export'] as const).map((title, i) => (
              <button
                key={title}
                type="button"
                className="step-rail-button"
                aria-label={`Expand steps at ${title}`}
                title={title}
                onClick={() => expandAtStep(i + 1)}
              >
                {i + 1}
              </button>
            ))}
          </nav>
        )}
        {!(!phoneLayout && layout.stepsCollapsed) && (
          <>
            <Step n={1} title="Open map" state={s1}>
              <p className="hint">
                A photo, scan, screenshot or PDF of the trail map. Straight-on scans trace best.
              </p>
              <div className="row">
                <OpenMapButton className="btn primary" />
                <StartSatelliteButton className="btn small" />
                <OpenProjectButton className="btn small" />
              </div>
              <PdfPagePicker />
            </Step>
            <Step n={2} title="Pin to real world" state={s2}>
              <AnchorsPanel />
              <GeorefToggle show={layout.show} onToggle={toggleBasemap} />
            </Step>
            <Step n={3} title="Trace" state={s3}>
              <TracePanel />
              <FeaturesPanel />
              <ConnectPanel />
            </Step>
            <Step n={4} title="Export" state={s4}>
              <ExportPanel />
            </Step>
          </>
        )}
      </aside>
    </div>
  );
}

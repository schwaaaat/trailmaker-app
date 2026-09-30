// Lane C. Anchor pairing state machine (card T-307).
import type { Anchor, AnchorId, HistoryCommand, LatLon, Project } from '../../core/types';
import { removeAnchor, setAnchorCoords } from '../../state/commands';
import { appStore, type AppState } from '../../state/store';

export type StageView = 'map' | 'basemap' | 'overlay';

/** Check if the current environment is a phone / narrow viewport (≤ 820px). */
export function isNarrowPhone(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(max-width: 820px)').matches;
    } catch {
      // fallback
    }
  }
  return typeof window.innerWidth === 'number' ? window.innerWidth <= 820 : false;
}

/**
 * Call T-219's stageView setter on the app store, with graceful fallback.
 */
export function setStageView(view: StageView, targetStore = appStore): void {
  const store = targetStore as unknown as {
    getState: () => { setStageView?: (v: StageView) => void; stageView?: StageView };
    setState: (partial: { stageView: StageView }) => void;
  };
  const state = store.getState();
  if (typeof state.setStageView === 'function') {
    state.setStageView(view);
  } else if (
    typeof (targetStore as unknown as { setStageView?: (v: StageView) => void }).setStageView ===
    'function'
  ) {
    (targetStore as unknown as { setStageView: (v: StageView) => void }).setStageView(view);
  } else if (typeof store.setState === 'function') {
    store.setState({ stageView: view });
  }
}

let prevPairingStatus: PairingStatus = 'idle';
let pairingPhoneSyncUnsub: (() => void) | null = null;

/**
 * Sync phone pairing tab switches: when status becomes 'pending' on a narrow viewport,
 * switches to the basemap tab. Returns a cleanup function.
 */
export function initPairingPhoneSync(store = appStore): () => void {
  if (pairingPhoneSyncUnsub) return pairingPhoneSyncUnsub;
  prevPairingStatus = getPairingState(store.getState()).status;
  const unsub = store.subscribe((state) => {
    const current = getPairingState(state);
    if (current.status === 'pending' && prevPairingStatus !== 'pending') {
      if (isNarrowPhone()) {
        setStageView('basemap', store);
      }
    }
    prevPairingStatus = current.status;
  });
  pairingPhoneSyncUnsub = () => {
    unsub();
    pairingPhoneSyncUnsub = null;
    prevPairingStatus = 'idle';
  };
  return pairingPhoneSyncUnsub;
}

export function stopPairingPhoneSync(): void {
  if (pairingPhoneSyncUnsub) {
    pairingPhoneSyncUnsub();
  }
}

export type PairingStatus =
  | 'idle'
  | 'armed'
  | 'pending'
  | 'set'
  | 'cancelled'
  | 'move-with-confirm';

export interface PairingStateInfo {
  readonly status: PairingStatus;
  /** Anchor currently pending coordinate pairing (i.e. ll === null). */
  readonly pendingAnchor: Anchor | null;
  /** 1-based index of pending anchor in project.anchors, or null. */
  readonly pendingAnchorNumber: number | null;
  /** Anchor currently selected, or null. */
  readonly selectedAnchor: Anchor | null;
  /** 1-based index of selected anchor in project.anchors, or null. */
  readonly selectedAnchorNumber: number | null;
}

export const PAIRING_PROMPT = 'Now click the same spot on the basemap';

function defaultConfirm(message: string): boolean {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return window.confirm(message);
  }
  return true;
}

/**
 * Determine the current pairing state from AppState.
 */
export function getPairingState(state: AppState): PairingStateInfo {
  const project = state.session?.project;
  if (!project) {
    return {
      status: 'idle',
      pendingAnchor: null,
      pendingAnchorNumber: null,
      selectedAnchor: null,
      selectedAnchorNumber: null,
    };
  }

  const selectedIndex = project.anchors.findIndex((a) => a.id === state.selectedAnchorId);
  const selectedAnchor = selectedIndex >= 0 ? project.anchors[selectedIndex]! : null;
  const selectedAnchorNumber = selectedIndex >= 0 ? selectedIndex + 1 : null;

  // An anchor is pending if selectedAnchor exists and has ll === null
  if (selectedAnchor && selectedAnchor.ll === null) {
    return {
      status: 'pending',
      pendingAnchor: selectedAnchor,
      pendingAnchorNumber: selectedAnchorNumber,
      selectedAnchor,
      selectedAnchorNumber,
    };
  }

  if (state.tool === 'anchor') {
    return {
      status: 'armed',
      pendingAnchor: null,
      pendingAnchorNumber: null,
      selectedAnchor,
      selectedAnchorNumber,
    };
  }

  return {
    status: 'idle',
    pendingAnchor: null,
    pendingAnchorNumber: null,
    selectedAnchor,
    selectedAnchorNumber,
  };
}

export interface BasemapClickDeps {
  readonly project: Project;
  readonly state: AppState;
  readonly edit: (cmd: HistoryCommand, select?: { anchor?: AnchorId | null }) => boolean;
  readonly confirm?: ((message: string) => boolean) | undefined;
}

export type BasemapClickResult =
  | { readonly action: 'none' }
  | { readonly action: 'set'; readonly anchorId: AnchorId; readonly ll: LatLon }
  | {
      readonly action: 'move-with-confirm';
      readonly anchorId: AnchorId;
      readonly anchorNumber: number;
      readonly ll: LatLon;
      readonly confirmed: boolean;
    };

/**
 * Handle a click on the basemap in accordance with the pairing state machine.
 */
export function handleBasemapClick(
  latLon: LatLon,
  deps: BasemapClickDeps,
): BasemapClickResult {
  const { project, state, edit, confirm = defaultConfirm } = deps;
  const pairing = getPairingState(state);

  // 1. Pending pairing: set coords directly
  if (pairing.status === 'pending' && pairing.pendingAnchor) {
    const anchorId = pairing.pendingAnchor.id;
    const cmd = setAnchorCoords(project, anchorId, latLon, 'basemap');
    edit(cmd, { anchor: anchorId });
    if (isNarrowPhone()) {
      setStageView('map');
    }
    return { action: 'set', anchorId, ll: latLon };
  }

  // 2. Existing anchor selected with coordinates and none pending: move with confirm
  if (
    pairing.selectedAnchor &&
    pairing.selectedAnchor.ll !== null &&
    pairing.selectedAnchorNumber !== null
  ) {
    const anchorId = pairing.selectedAnchor.id;
    const n = pairing.selectedAnchorNumber;
    const confirmed = confirm(`Move anchor ${n} here?`);
    if (confirmed) {
      const cmd = setAnchorCoords(project, anchorId, latLon, 'basemap');
      edit(cmd, { anchor: anchorId });
    }
    return {
      action: 'move-with-confirm',
      anchorId,
      anchorNumber: n,
      ll: latLon,
      confirmed,
    };
  }

  return { action: 'none' };
}

export interface CancelPairingDeps {
  readonly project: Project;
  readonly state: AppState;
  readonly edit: (cmd: HistoryCommand) => boolean;
  readonly selectAnchor: (id: AnchorId | null) => void;
}

export type CancelPairingResult =
  | { readonly action: 'none' }
  | { readonly action: 'cancel'; readonly anchorId: AnchorId };

/**
 * Handle Escape key or explicit cancellation of pending pairing.
 */
export function handleCancelPairing(deps: CancelPairingDeps): CancelPairingResult {
  const { project, state, edit, selectAnchor } = deps;
  const pairing = getPairingState(state);

  if (pairing.status === 'pending' && pairing.pendingAnchor) {
    const anchorId = pairing.pendingAnchor.id;
    edit(removeAnchor(project, anchorId));
    selectAnchor(null);
    if (isNarrowPhone()) {
      setStageView('map');
    }
    return { action: 'cancel', anchorId };
  }

  return { action: 'none' };
}

// Auto-initialize pairing sync in browser environment
if (typeof window !== 'undefined') {
  initPairingPhoneSync();
}

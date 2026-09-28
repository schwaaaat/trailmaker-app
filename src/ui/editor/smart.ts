// Lane B. Smart follow and the ink picker (card T-206): the prototype's smart branch of
// draftClick, pickInk and the 'ink' tool, running on the worker. Installed on one Editor.
import { nameColor, rgbToHex } from '../../core/trace/color';
import type { Px, Rgb } from '../../core/types';
import { addChips, setTraceSettings } from '../../state/commands';
import { appStore, edit, sealHistory, setDraft, showToast, type Draft } from '../../state/store';
import {
  call,
  imageFor,
  isCancelled,
  jobDone,
  startJob,
  stillOn,
  cancelJob,
  isReported,
  jobsIdle,
  pendingJobs,
  track,
} from '../../state/worker-link';
import type { Editor, EditorEvents, HopProvider } from './Editor';
import { chooseTool, settled } from './tools';
import type { View } from './view';

/** Hops slower than this get the prototype's "shorter hops" tip, ms. */
export const SLOW_HOP_MS = 900;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Ink pick radius: 5 screen px (prototype), in image px, clamped as WorkerApi.pickInk does. */
export const pickRadius = (view: View) => clamp(5 / view.s, 1, 14);
/** Snap radius: 8 screen px (prototype), in image px, clamped as SmartTraceRequest says. */
export const snapRadius = (view: View) => clamp(8 / view.s, 2, 30);

const state = () => appStore.getState();

function cancelledError(): Error {
  const err = new Error('Superseded');
  err.name = 'JobCancelled';
  return err;
}

/** Smart follow for trail/area drafts (T-204's hop hook). */
export class SmartFollow implements HopProvider {
  private hopJob: string | null = null;

  async start(at: Px, view: View): Promise<{ at: Px; ink: Rgb | null }> {
    const s = state();
    const map = s.session?.map;
    const p = s.session?.project;
    if (!map || !p?.trace.smartFollow) return { at, ink: null };
    const id = await imageFor(map);
    // The user's picked color wins; otherwise pick it from this first click (prototype autoInk).
    const ink = p.trace.ink ?? (await call((api) => api.pickInk(id, at, pickRadius(view))));
    if (!stillOn(map)) throw cancelledError();
    if (!p.trace.ink) appStore.setState({ lastInk: ink });
    const snapped = await call((api) =>
      api.snapToInk(id, at, ink, p.trace.tolerance, snapRadius(view)),
    );
    if (!stillOn(map)) throw cancelledError();
    return { at: snapped ?? at, ink };
  }

  async hop(from: Px, to: Px, draft: Draft, view: View): Promise<readonly Px[] | null> {
    const s = state();
    const map = s.session?.map;
    const p = s.session?.project;
    if (!map || !p?.trace.smartFollow || !draft.ink) return [to];
    const ink = draft.ink;
    const id = await imageFor(map);
    const jobId = startJob(map);
    this.hopJob = jobId;
    const t0 = performance.now();
    try {
      const res = await call((api) =>
        api.smartTrace(
          {
            imageId: id,
            from,
            to,
            ink,
            tolerance: p.trace.tolerance,
            snapRadiusPx: snapRadius(view),
          },
          { jobId },
        ),
      );
      if (!stillOn(map)) throw cancelledError();
      const path = res.path;
      let out: readonly Px[];
      if (!path || path.length < 2) {
        // Prototype: a straight segment to the snapped click, with this toast.
        showToast(
          'Too far to follow in one step, so a straight segment was added. Click in shorter hops.',
        );
        out = [res.snappedTo];
      } else {
        // The path starts at `from`, which the draft already has.
        out = path.slice(1);
      }
      if (performance.now() - t0 > SLOW_HOP_MS) showToast('Tip: shorter hops trace faster.');
      return out;
    } finally {
      jobDone(jobId);
      if (this.hopJob === jobId) this.hopJob = null;
    }
  }

  cancel(): void {
    if (this.hopJob) void cancelJob(this.hopJob);
  }
}

/** The ink picker tool: pick a trail color for smart follow or for a new auto-trace chip. */
async function pickInkAt(e: EditorEvents['click'], view: View): Promise<void> {
  const s = state();
  const map = s.session?.map;
  if (!map || !e.inside) return;
  const id = await imageFor(map);
  const rgb = await call((api) => api.pickInk(id, e.px, pickRadius(view)));
  const p = state().session?.project;
  if (!p || !stillOn(map) || state().tool !== 'ink') return;
  const hex = rgbToHex(rgb);
  if (state().inkFor === 'chip') {
    const { command } = addChips(p, [
      { rgb, name: nameColor(rgb), enabled: true, share: null, named: false },
    ]);
    if (command) edit(command);
    sealHistory();
    appStore.setState({ inkFor: null });
    chooseTool('select');
    showToast(`Added ${hex}. Press Find trails when your colors are ready.`);
    return;
  }
  edit(setTraceSettings(p, { ink: rgb }));
  sealHistory();
  const d = state().draft;
  if (d) setDraft({ ...d, ink: rgb });
  appStore.setState({ inkFor: null });
  chooseTool(state().prevTool);
  showToast(`Following ${hex}`);
}

/** Wire smart follow and the ink tool to an Editor. Returns a function that unwires them. */
export function installSmartFollow(editor: Editor): () => void {
  const smart = new SmartFollow();
  editor.setHopProvider(smart);
  const off = editor.on('click', (e) => {
    if (state().tool !== 'ink') return;
    const view = editor.view;
    void track(pickInkAt(e, view)).catch((err: unknown) => {
      if (!isCancelled(err) && !isReported(err)) {
        showToast(
          `Picking the color didn’t work: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  });
  return () => {
    off();
    smart.cancel();
    editor.setHopProvider(null);
  };
}

/**
 * Resolves once no drafting work is queued and no worker call is in flight (TestHook.idle).
 * Loops, because a queued hop can start a worker call after the queue looked settled.
 */
export async function idle(): Promise<void> {
  for (;;) {
    const q = settled();
    await q;
    await jobsIdle();
    if (settled() === q && pendingJobs() === 0) return;
  }
}

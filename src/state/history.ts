// Lane B. Command-based undo/redo (card T-201), replacing the prototype's 120-deep JSON
// snapshot stack with exact apply/revert commands, plus redo.
import { HISTORY_LIMIT, type HistoryCommand, type Project } from '../core/types';

/**
 * One undo step: a run of commands that coalesced (usually one). Kept flat and walked
 * iteratively so an arbitrarily long run (a long slider drag) cannot overflow the stack.
 */
interface Step {
  readonly commands: HistoryCommand[];
}

const label = (s: Step): string => s.commands[s.commands.length - 1]!.label;
const key = (s: Step): string | null => s.commands[s.commands.length - 1]!.coalesceKey;

function applyStep(s: Step, project: Project): Project {
  let p = project;
  for (const c of s.commands) p = c.apply(p);
  return p;
}

function revertStep(s: Step, project: Project): Project {
  let p = project;
  for (let i = s.commands.length - 1; i >= 0; i--) p = s.commands[i]!.revert(p);
  return p;
}

/**
 * Undo/redo stacks. Framework-free: callers pass the current project in and store the
 * project that comes back. If a command's apply/revert throws, the stacks are left unchanged.
 */
export class History {
  private past: Step[] = [];
  private future: Step[] = [];
  /** Whether the top of `past` may absorb the next command with the same coalesceKey. */
  private open = false;

  constructor(private readonly limit: number = HISTORY_LIMIT) {}

  /** Capture both stacks and the coalescing boundary for a gesture that may be cancelled. */
  checkpoint(): () => void {
    const copy = (steps: readonly Step[]): Step[] => steps.map((step) => ({ commands: [...step.commands] }));
    const past = copy(this.past);
    const future = copy(this.future);
    const open = this.open;
    return () => {
      this.past = copy(past);
      this.future = copy(future);
      this.open = open;
    };
  }

  /** Apply cmd, record it (coalescing with the previous step when keys match) and clear redo. */
  execute(project: Project, cmd: HistoryCommand): Project {
    const next = cmd.apply(project);
    const top = this.past[this.past.length - 1];
    if (this.open && top && cmd.coalesceKey !== null && key(top) === cmd.coalesceKey) {
      top.commands.push(cmd);
    } else {
      this.past.push({ commands: [cmd] });
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future = [];
    this.open = cmd.coalesceKey !== null;
    return next;
  }

  /** Undo one step; null when there is nothing to undo. */
  undo(project: Project): Project | null {
    const step = this.past[this.past.length - 1];
    if (!step) return null;
    const prev = revertStep(step, project);
    this.past.pop();
    this.future.push(step);
    this.open = false;
    return prev;
  }

  /** Redo one step; null when there is nothing to redo. */
  redo(project: Project): Project | null {
    const step = this.future[this.future.length - 1];
    if (!step) return null;
    const next = applyStep(step, project);
    this.future.pop();
    this.past.push(step);
    this.open = false;
    return next;
  }

  /** End the current coalescing run (e.g. a name field lost focus, a drag ended). */
  seal(): void {
    this.open = false;
  }

  /** Forget everything (a new session was opened). */
  clear(): void {
    this.past = [];
    this.future = [];
    this.open = false;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Label of the step undo() would revert, or null. */
  get undoLabel(): string | null {
    const s = this.past[this.past.length - 1];
    return s ? label(s) : null;
  }

  /** Label of the step redo() would apply, or null. */
  get redoLabel(): string | null {
    const s = this.future[this.future.length - 1];
    return s ? label(s) : null;
  }

  /** Number of undoable steps. */
  get depth(): number {
    return this.past.length;
  }
}

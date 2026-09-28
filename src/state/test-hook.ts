/// <reference types="vite/client" />
// Lane B. Installs window.__trailmaker (TestHook, src/ui/contract.ts) for Playwright, in
// dev/test builds only. Members arrive from the cards that own them: session here (T-201),
// imageToClient with the editor (T-203), idle with the worker client (T-206).
import type { TestHook } from '../ui/contract';

/** True in `vite` dev and Vitest; false in production builds. */
export const testHookEnabled = import.meta.env.DEV || import.meta.env.MODE === 'test';

/** Merge members into window.__trailmaker. A no-op in production builds. */
export function installTestHook(members: Partial<TestHook>): void {
  if (!testHookEnabled) return;
  // Partial until every owning card has installed its member (see header).
  window.__trailmaker = Object.assign(window.__trailmaker ?? {}, members) as TestHook;
}

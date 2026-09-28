// Lane B. Stepwise export work (card T-211). Large exports are written as generators that yield
// after each small piece of work; the app runs them in time slices on the main thread, and the
// plain functions (toExportDocument, buildExportZip) just run them to the end.

/** Run a step generator to completion and return its result. */
export function drain<T>(steps: Generator<unknown, T, undefined>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

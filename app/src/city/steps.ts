/**
 * Work in steps (Task 13): a builder written as a generator yields wherever
 * the city may stop and draw a frame before going on. Run to the end at
 * once with finish(), or a step at a time on the city's re-merge queue
 * (batch.ts scheduleRemerge) with stepper().
 */
export type Steps<T> = Generator<void, T, void>;

/** Runs the steps to the end now and returns what they built. */
export function finish<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Queue work that takes one step a call and says whether more are left; `done` gets what was built. */
export function stepper<T>(steps: Steps<T>, done: (value: T) => void): () => boolean {
  return () => {
    const r = steps.next();
    if (!r.done) return true;
    done(r.value);
    return false;
  };
}

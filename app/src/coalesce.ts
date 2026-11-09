/**
 * Wraps an async job so triggers never overlap and never get lost: a trigger
 * while the job is running marks it dirty, and the job runs exactly once
 * more when the current run finishes, however many triggers arrived.
 */
export function coalesced(run: () => Promise<void>): () => void {
  let running = false;
  let dirty = false;

  const start = (): void => {
    running = true;
    dirty = false;
    void run()
      .catch(() => {})
      .finally(() => {
        running = false;
        if (dirty) start();
      });
  };

  return () => {
    if (running) {
      dirty = true;
      return;
    }
    start();
  };
}

/**
 * What else follows the camera each frame, after the plates (Task 8): the screens' pins and lock-ons subscribe
 * here through City.onFrame. With nothing subscribed a frame costs one size check.
 */
export interface FrameHooks {
  /** Runs `fn` every frame from the next one on. The returned function removes it; calling it twice is harmless. */
  add(fn: () => void): () => void;
  /** Runs every hook once, in the order added. A hook that throws is logged once and removed; the rest still run. */
  run(): void;
  /** How many hooks are subscribed (tests). */
  size(): number;
}

export function createFrameHooks(log: (...args: unknown[]) => void = (...args) => console.error(...args)): FrameHooks {
  const hooks = new Set<() => void>();
  // The order the frame runs them in, rebuilt only when a hook comes or goes, so a frame allocates nothing.
  let order: Array<() => void> = [];
  let stale = false;

  function remove(fn: () => void): void {
    if (hooks.delete(fn)) stale = true;
  }

  return {
    add(fn) {
      if (!hooks.has(fn)) {
        hooks.add(fn);
        stale = true;
      }
      return () => remove(fn);
    },
    run() {
      if (hooks.size === 0) return;
      if (stale) {
        order = [...hooks];
        stale = false;
      }
      const now = order;
      for (let i = 0; i < now.length; i++) {
        const fn = now[i];
        // Removed earlier in this frame by another hook: it does not run.
        if (!hooks.has(fn)) continue;
        try {
          fn();
        } catch (err) {
          remove(fn);
          log('A frame hook failed and was removed:', err);
        }
      }
    },
    size: () => hooks.size,
  };
}

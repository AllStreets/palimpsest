/**
 * The city's hold (screens redesign Task 12): while a screen stands over the
 * city and hides it (terminal mode, where it is blurred and dimmed far
 * behind), the city stops drawing and the last frame stays on the canvas, so
 * the page composites a still layer. A resize while held owes one frame,
 * drawn on the next tick, so the still is never stretched. Released, every
 * tick draws again. Its own file, so node can test it.
 */
export interface RenderHold {
  /** Holds (true) or releases (false). Releasing always draws again, whatever was owed. */
  set(on: boolean): void;
  /** A resize: one frame is owed while held. */
  owe(): void;
  /** Whether this tick draws: always when released; once per owed frame when held. */
  draws(): boolean;
  held(): boolean;
}

export function renderHold(): RenderHold {
  let held = false;
  let owed = false;
  return {
    set(on) {
      held = on;
      owed = false;
    },
    owe() {
      if (held) owed = true;
    },
    draws() {
      if (!held) return true;
      if (!owed) return false;
      owed = false;
      return true;
    },
    held: () => held,
  };
}

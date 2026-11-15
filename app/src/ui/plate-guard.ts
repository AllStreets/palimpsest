/**
 * While a sheet is open, a name plate whose foot stands under the sheet
 * would show its words half past the paper's edge (the Phase 5 audit saw
 * "exchange / jobs posted" cut by the school's edge). The guard marks such a
 * plate `data-under-sheet`, and the stylesheet steps it aside whole; a plate
 * whose foot stands past the edge shows whole, since its words run right,
 * away from the sheet. The plates are the city's own; the guard only reads
 * where each stands and sets one attribute.
 */

/** For each plate's foot (its x on the screen), whether it stands under a sheet whose right edge is at `sheetRight`; none when no sheet is open. */
export function underSheet(feet: readonly number[], sheetRight: number | null): boolean[] {
  return feet.map((x) => sheetRight !== null && x < sheetRight);
}

/** How often the guard looks, in frames: the plates move only with the camera. */
const EVERY = 4;

/** Starts the guard on `doc`; it reads only while a sheet is open. */
export function guardPlates(doc: Document): void {
  const win = doc.defaultView;
  if (!win) return;
  let frame = 0;
  let marked = false;
  const look = (): void => {
    win.requestAnimationFrame(look);
    if (frame++ % EVERY !== 0) return;
    const open = [...doc.querySelectorAll<HTMLElement>('.sheet')].find((s) => !s.hidden);
    const plates = [...doc.querySelectorAll<HTMLElement>('.plates .plate')];
    if (!open) {
      if (marked) for (const p of plates) delete p.dataset.underSheet;
      marked = false;
      return;
    }
    const edge = open.getBoundingClientRect().right;
    const under = underSheet(
      plates.map((p) => p.getBoundingClientRect().left),
      edge,
    );
    plates.forEach((p, i) => {
      if (under[i]) p.dataset.underSheet = '';
      else delete p.dataset.underSheet;
    });
    marked = true;
  };
  win.requestAnimationFrame(look);
}

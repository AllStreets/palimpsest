/**
 * While a sheet is open, a name plate whose foot stands under the sheet
 * would show its words half past the paper's edge (the Phase 5 audit saw
 * "exchange / jobs posted" cut by the school's edge). The guard marks such a
 * plate `data-under-sheet`, and the stylesheet steps it aside whole; a plate
 * whose foot stands past the edge shows whole, since its words run right,
 * away from the sheet. The plates are the city's own; the guard only reads
 * where each stands and sets one attribute, and tells the plates where the
 * pane right of the sheet begins (setPlatePane), so their flip and their
 * collision pass keep inside what shows.
 */

import { setPlatePane } from '../city/labels.js';

/** For each plate's foot (its x on the screen), whether it stands under a sheet whose right edge is at `sheetRight`; none when no sheet is open. */
export function underSheet(feet: readonly number[], sheetRight: number | null): boolean[] {
  return feet.map((x) => sheetRight !== null && x < sheetRight);
}

/** How often the guard looks, in frames: the plates move only with the camera. */
const EVERY = 4;

/**
 * Starts the guard on `doc`. It looks only while a sheet is open: a watch on
 * the sheets' `hidden` starts the frame loop when one opens and stops it
 * (clearing every mark) when the last closes, so a city with no sheet costs
 * nothing.
 */
export function guardPlates(doc: Document): void {
  const win = doc.defaultView;
  if (!win) return;
  let frame = 0;
  let raf: number | null = null;
  let open: HTMLElement | null = null;
  const plates = (): HTMLElement[] => [...doc.querySelectorAll<HTMLElement>('.plates .plate')];
  const look = (): void => {
    raf = win.requestAnimationFrame(look);
    if (!open || frame++ % EVERY !== 0) return;
    const all = plates();
    const edge = open.getBoundingClientRect().right;
    // The city's plates keep their flip and their fit inside the pane right of the sheet (labels.ts).
    setPlatePane(edge);
    const under = underSheet(
      all.map((p) => p.getBoundingClientRect().left),
      edge,
    );
    all.forEach((p, i) => {
      if (under[i]) p.dataset.underSheet = '';
      else delete p.dataset.underSheet;
    });
  };
  const watch = (): void => {
    open = [...doc.querySelectorAll<HTMLElement>('.sheet')].find((s) => !s.hidden) ?? null;
    if (open && raf === null) {
      frame = 0;
      raf = win.requestAnimationFrame(look);
    } else if (!open && raf !== null) {
      win.cancelAnimationFrame(raf);
      raf = null;
      setPlatePane(0);
      for (const p of plates()) delete p.dataset.underSheet;
    }
  };
  new MutationObserver((records) => {
    if (records.some((r) => r.target instanceof HTMLElement && r.target.classList.contains('sheet'))) watch();
  }).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  watch();
}

/**
 * The screens' panel: a sheet dressed as three panes at three depths. The
 * back pane stands farthest, wide and low behind the panel, lit on its right
 * and foot. The panel holds the list over its warm black ground, with the
 * stream of the brief's own words under it. The head is the nearest plate,
 * proud of the panel at its left and casting down and right onto the list.
 * Four amber brackets and a range rail mark the panel; it has no other edge.
 *
 * Hovering the panel leans the head with the pointer and the back pane
 * against it (leanPanes), by transform alone, from one frame at a time. It
 * opens with one scan across the head (motion.ts scanOnce). Under reduced
 * motion the panes stay at rest and no scan runs.
 *
 * Styles are in panel.css (through index.css); this module brings none, so
 * it runs in node for its tests.
 */
import type { Sheet } from '../controls.js';
import { scanOnce, stillMotion } from './motion.js';
import { createStream } from './stream.js';
import { parallaxOffset } from './tokens.js';

export interface OsPanel {
  root: HTMLElement;
  /** The head: the near pane. */
  head: HTMLElement;
  /** The body: the list. */
  list: HTMLElement;
  /** The back pane: the far one. */
  back: HTMLElement;
  /** The words the stream behind the list is made of. Rebuilt only when they change. */
  setStream(words: string[]): void;
  /** Takes the dress off: the sheet is as createSheet made it. */
  dispose(): void;
}

const px = (o: { x: number; y: number }): string => `translate3d(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px, 0)`;

/**
 * Leans `near` with the pointer over `host` and `far` against it. The host's
 * rect is read on pointerenter only; moves ask for one frame, and that frame
 * writes the two transforms. On pointerleave both go back to rest. Under
 * reduced motion nothing leans. Returns the unlean, which leaves both at rest.
 */
export function leanPanes(host: HTMLElement, near: HTMLElement, far: HTMLElement): () => void {
  let rect: { left: number; top: number; width: number; height: number } | null = null;
  let at: { x: number; y: number } | null = null;
  let frame = 0;

  const write = (): void => {
    frame = 0;
    if (rect && at) {
      near.style.transform = px(parallaxOffset(at, rect, 'near'));
      far.style.transform = px(parallaxOffset(at, rect, 'far'));
    } else {
      near.style.transform = '';
      far.style.transform = '';
    }
  };
  const ask = (): void => {
    if (!frame) frame = requestAnimationFrame(write);
  };

  const enter = (): void => {
    if (stillMotion()) return;
    rect = host.getBoundingClientRect();
  };
  const move = (e: PointerEvent): void => {
    if (!rect) return;
    at = { x: e.clientX, y: e.clientY };
    ask();
  };
  const leave = (): void => {
    if (!rect) return;
    rect = null;
    at = null;
    ask();
  };

  host.addEventListener('pointerenter', enter);
  host.addEventListener('pointermove', move, { passive: true });
  host.addEventListener('pointerleave', leave);
  return () => {
    host.removeEventListener('pointerenter', enter);
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerleave', leave);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    rect = null;
    at = null;
    write();
  };
}

const mark = (cls: string): HTMLElement => {
  const n = document.createElement('span');
  n.className = cls;
  return n;
};

/**
 * Dresses `sheet` as the screens' panel. The sheet keeps its own head, body,
 * show and hide; the panel adds its marks, the back pane and the stream, and
 * runs one scan across the head each time the sheet opens.
 */
export function dressPanel(sheet: Sheet): OsPanel {
  const root = sheet.root;
  const head = root.querySelector<HTMLElement>('.sheet-head');
  if (!head) throw new Error('dressPanel: the sheet has no head');
  const list = sheet.body;
  root.classList.add('os-panel');

  const back = document.createElement('div');
  back.className = 'os-back';
  back.setAttribute('aria-hidden', 'true');
  root.prepend(back);

  const marks = document.createElement('div');
  marks.className = 'os-marks';
  marks.setAttribute('aria-hidden', 'true');
  for (const c of ['tl', 'tr', 'bl', 'br']) marks.append(mark(`os-corner ${c}`));
  marks.append(mark('os-rail'));
  root.append(marks);

  // The stream sits behind the list, from the head's foot down; the head's height changes with what it holds.
  const stream = createStream(root);
  const foot = (): void => root.style.setProperty('--os-head', `${head.offsetTop + head.offsetHeight}px`);
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(foot) : null;
  sized?.observe(head);

  const unlean = leanPanes(root, head, back);

  const show = sheet.show;
  sheet.show = function (this: Sheet): void {
    const opening = !sheet.shown;
    show.call(sheet);
    if (!opening) return;
    if (!sized) foot();
    scanOnce(head);
  };

  return {
    root,
    head,
    list,
    back,
    setStream: (words) => stream.fill(words),
    dispose() {
      sheet.show = show;
      unlean();
      sized?.disconnect();
      stream.root.remove();
      marks.remove();
      back.remove();
      root.style.removeProperty('--os-head');
      root.classList.remove('os-panel');
    },
  };
}

/**
 * The screens' two small motions, each with its still equivalent.
 *
 * typeIn types a line of plain text in, at MOTION.typeCps, and never takes
 * longer than MOTION.typeMaxMs: a long line speeds up rather than running long.
 * It is for plain text only. A run summary (safe markdown) is never typed; it
 * reveals with a sweep instead (Task 17). Text is set with textContent alone.
 *
 * scanOnce runs one hairline cursor across a host, once (motion.css). The host
 * must be positioned, so the cursor stands inside it.
 *
 * Under prefers-reduced-motion both are still: the text is whole at once, and
 * no cursor runs.
 */
import { MOTION } from './tokens.js';

/** The frame the type-in plans for: 60 a second. */
const FRAME_MS = 16;

/**
 * How many characters show at each frame, cumulative and non-decreasing, one
 * entry a frame, ending at `length`. The run lasts length / cps seconds, or
 * maxMs if that is shorter. Still, or nothing to type, is a single frame.
 */
export function typeSteps(length: number, cps: number, frameMs: number, maxMs: number, still: boolean): number[] {
  const n = Math.max(0, Math.floor(length));
  if (still || n === 0 || cps <= 0 || frameMs <= 0) return [n];
  const ms = Math.min((n / cps) * 1000, maxMs);
  const frames = Math.max(1, Math.floor(ms / frameMs));
  const out: number[] = [];
  for (let i = 1; i < frames; i++) out.push(Math.floor((n * i) / frames));
  out.push(n);
  return out;
}

/** Whether the viewer asks for reduced motion. */
export function stillMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Types `text` into `node`, and returns a cancel. The whole text is the
 * node's aria-label from the start, so a screen reader reads it once, whole.
 * Whether it finishes or is cancelled, the node ends with the whole text.
 */
export function typeIn(node: HTMLElement, text: string, opts: { cps?: number } = {}): () => void {
  node.setAttribute('aria-label', text);
  const steps = typeSteps(text.length, opts.cps ?? MOTION.typeCps, FRAME_MS, MOTION.typeMaxMs, stillMotion());
  let shown = -1;
  const show = (count: number): void => {
    if (count === shown) return;
    shown = count;
    node.textContent = text.slice(0, count);
  };
  if (steps.length === 1) {
    show(text.length);
    return () => show(text.length);
  }

  let handle = 0;
  let start: number | null = null;
  // Indexed by elapsed time, not by frames drawn, so a slow frame never makes it run long.
  const frame = (now: number): void => {
    if (start === null) start = now;
    const i = Math.min(steps.length - 1, Math.floor((now - start) / FRAME_MS));
    show(steps[i]);
    handle = i < steps.length - 1 ? requestAnimationFrame(frame) : 0;
  };
  show(0);
  handle = requestAnimationFrame(frame);
  return () => {
    if (handle) cancelAnimationFrame(handle);
    handle = 0;
    show(text.length);
  };
}

/**
 * Runs the scan once over `host`: the class os-scanning for MOTION.scanMs, and
 * the cursor inside it (motion.css), both removed after. Does nothing when
 * still, and nothing new while a scan is already running.
 */
export function scanOnce(host: HTMLElement): void {
  if (stillMotion() || host.classList.contains?.('os-scanning')) return;
  const cursor = document.createElement('span');
  cursor.className = 'os-scan';
  cursor.setAttribute('aria-hidden', 'true');
  host.classList.add('os-scanning');
  host.append(cursor);
  setTimeout(() => {
    cursor.remove();
    host.classList.remove('os-scanning');
  }, MOTION.scanMs);
}

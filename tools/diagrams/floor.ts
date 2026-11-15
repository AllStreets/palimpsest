/**
 * How a job becomes a floor: the job's states on one line, every legal move
 * out of them from the code's own table, the run's stages under the states
 * they run in, inspection's checks, the two ways a pass ships, and the
 * floor each ending leaves.
 */
import type { JobStatus, RunStage } from '../../shared/types.js';
import {
  AWARD_RULE,
  CHECK_LABEL,
  CHECK_STATUS_LABEL,
  CHECKS,
  FLOOR_STATE_LABEL,
  FLOOR_STATES,
  JOB_EXITS,
  JOB_LINE,
  JOB_STATE_LABEL,
  legalMoves,
  MAX_ATTEMPTS,
  REOPEN_NOTES,
  RUN_STAGE_LABEL,
  RUN_STAGE_UNDER,
  RUN_STAGES,
  SHIP_MODES,
} from './data.js';
import { Sheet, type Diagram } from './sheet.js';

const W = 1600;
const H = 1100;
const X0 = 292;
const STEP = 146;
const RAIL = 200;
const LEFT = 80;

/** The rows under the line, top to bottom: back to open, then each exit. */
const ROWS: JobStatus[] = ['open', ...JOB_EXITS];
const ROW0 = 286;
const ROW_STEP = 64;

const RUN_Y = 626;
const PANEL_Y = 740;

const colX = (s: JobStatus): number => X0 + STEP * (JOB_LINE as readonly JobStatus[]).indexOf(s);
const rowY = (s: JobStatus): number => ROW0 + ROW_STEP * ROWS.indexOf(s);
const onLine = (s: JobStatus): boolean => (JOB_LINE as readonly JobStatus[]).includes(s);

export function floor(): Diagram {
  const s = new Sheet(W, H);
  const moves = legalMoves();
  const key = (a: JobStatus, b: JobStatus) => `move:${a}>${b}`;

  s.text(LEFT, 92, 'How a job becomes a floor', { kind: 'title' });

  // ------------------------------------------------------------ the line
  s.text(LEFT, RAIL + 6, 'The job', { kind: 'head' });
  const first = colX(JOB_LINE[0]);
  const last = colX(JOB_LINE[JOB_LINE.length - 1]);

  // Forward moves between neighbours make the line; any other forward move arcs over it.
  const forward = moves.filter(([a, b]) => onLine(a) && onLine(b) && colX(b) > colX(a));
  for (const [a, b] of forward) {
    if (colX(b) - colX(a) === STEP) {
      s.line(colX(a) + 7, RAIL, colX(b) - 7, RAIL, 'l-ink');
      s.arrow(colX(b) - 8, RAIL, 0, 'l-ink', 5);
      s.raw(`<g data-keys="${key(a, b)}"></g>`);
    }
  }
  for (const [a, b] of forward.filter(([a, b]) => colX(b) - colX(a) > STEP)) {
    const xa = colX(a);
    const xb = colX(b);
    const top = RAIL - 64;
    s.path(`M${xa},${RAIL - 7} C${xa},${top} ${xb},${top} ${xb},${RAIL - 7}`, 'l-accent');
    s.arrow(xb, RAIL - 8, 90, 'l-accent', 6);
    const mode = SHIP_MODES.find((m) => m.move === `${a}>${b}`);
    s.text((xa + xb) / 2, top + 2, mode ? mode.label : `Straight to ${JOB_STATE_LABEL[b].toLowerCase()}`, { kind: 'figure', anchor: 'middle', keys: [key(a, b)], cls: 't-accent' });
  }
  // The pull request's way out of shipping is the line itself: name it under the line.
  const pr = SHIP_MODES.find((m) => m.move === 'shipping>waiting');
  if (pr && moves.some(([a, b]) => a === 'shipping' && b === 'waiting')) {
    s.text((colX('shipping') + colX('waiting')) / 2, RAIL - 12, pr.label, { kind: 'figure', anchor: 'middle', keys: ['move:shipping>waiting'] });
  }

  for (const st of JOB_LINE) {
    const x = colX(st);
    const terminal = moves.every(([a]) => a !== st);
    if (terminal) s.dot(x, RAIL, 6.5, 'f-accent');
    else s.ring(x, RAIL, 5.5);
    s.text(x + 12, RAIL + 30, JOB_STATE_LABEL[st], { kind: 'node', keys: [`job:${st}`], cls: terminal ? 't-accent' : undefined });
  }

  // ------------------------------------------------------------ the ways off the line
  const down = moves.filter(([a, b]) => onLine(a) && (!onLine(b) || (b === 'open' && colX(b) < colX(a))));
  const deepest = new Map<JobStatus, number>();
  for (const [a, b] of down) deepest.set(a, Math.max(deepest.get(a) ?? 0, rowY(b)));

  for (const r of ROWS) {
    const y = rowY(r);
    const xs = down.filter(([, b]) => b === r).map(([a]) => colX(a));
    if (xs.length) s.line(X0 - 40, y, last + 40, y, 'l-rule');
  }
  // Column guides from each state down to its last way out, and on to its run.
  for (const st of JOB_LINE) {
    const x = colX(st);
    const held = (Object.keys(RUN_STAGE_UNDER) as RunStage[]).filter((r) => RUN_STAGE_UNDER[r] === st).length;
    const runs = held > 0;
    const to = runs ? RUN_Y + 26 - (held - 1) * 26 - 7 : (deepest.get(st) ?? RAIL);
    if (to > RAIL) s.line(x, RAIL + 7, x, to, runs ? 'l-rule l-dash' : 'l-rule');
    if (deepest.has(st)) s.line(x, RAIL + 7, x, deepest.get(st)!, 'l-strong');
  }
  for (const [a, b] of down) {
    const x = colX(a);
    const y = rowY(b);
    s.dot(x, y, 3.6, b === 'failed' || b === 'halted' ? 'f-ink' : 'f-ink', [key(a, b)]);
    const note = b === 'open' ? REOPEN_NOTES[`${a}>open`] : undefined;
    if (note) s.text(x + 9, y - 8, note, { kind: 'figure', keys: [key(a, b)], wrap: 128, lineHeight: 15, valign: 'bottom' });
  }

  // Row heads, with where each row goes next.
  const after = (r: JobStatus) => moves.filter(([a]) => a === r);
  for (const r of ROWS) {
    const y = rowY(r);
    s.text(LEFT, y + 6, r === 'open' ? 'Back to open' : JOB_STATE_LABEL[r], { kind: 'small', keys: r === 'open' ? [] : [`job:${r}`] });
    const out = after(r);
    if (r === 'open') continue;
    if (out.length === 0) {
      s.text(LEFT, y + 24, 'Final', { kind: 'figure' });
      continue;
    }
    const words = out.map(([, b], i) => {
      const n = REOPEN_NOTES[`${r}>${b}`];
      const or = i > 0 ? 'or ' : '';
      if (b === 'open') return r === 'failed' ? `Open again ${n?.toLowerCase() ?? ''}`.trim() : `${n ?? 'Back'} to open`;
      if (b === 'waiting') return `${or}to waiting if its pull request is open`;
      return `${or}${JOB_STATE_LABEL[b].toLowerCase()}`;
    });
    s.text(LEFT, y + 24, words.join(', '), { kind: 'figure', keys: out.map(([a, b]) => key(a, b)), wrap: 200, lineHeight: 15 });
  }

  // ------------------------------------------------------------ the run
  s.text(LEFT, RUN_Y + 32, 'Its run', { kind: 'head' });
  const runCols = JOB_LINE.filter((st) => RUN_STAGES.some((r) => RUN_STAGE_UNDER[r] === st));
  // The first stage sits a step above the rail when its job state holds more than one: preparing, then installing.
  const RUN_RAIL = RUN_Y + 26;
  s.line(colX(runCols[0]), RUN_RAIL, colX(runCols[runCols.length - 1]), RUN_RAIL, 'l-strong');
  for (const st of runCols) {
    const stages = RUN_STAGES.filter((r) => RUN_STAGE_UNDER[r] === st);
    const x = colX(st);
    stages.forEach((r, i) => {
      const y = RUN_RAIL - (stages.length - 1 - i) * 26;
      if (i > 0) s.line(x, y - 22, x, y - 4, 'l-strong');
      s.dot(x, y, 3.6, r === 'done' ? 'f-accent' : 'f-ink');
      s.text(x + 11, y + 5, RUN_STAGE_LABEL[r], { kind: 'small', keys: [`stage:${r}`], cls: r === 'done' ? 'halo t-accent' : 'halo' });
    });
  }

  // ------------------------------------------------------------ four panels: what happens at each step
  s.line(LEFT, PANEL_Y - 34, W - LEFT, PANEL_Y - 34, 'l-rule');
  const panel = (x: number, head: string) => s.text(x, PANEL_Y, head, { kind: 'head' });

  const PX = [LEFT, 450, 840, 1210];
  // The award.
  panel(PX[0], 'Awarded: the best expected value');
  s.text(PX[0], PANEL_Y + 34, AWARD_RULE, { kind: 'note', keys: ['rule:award'], wrap: 320, lineHeight: 20 });
  s.text(PX[0], PANEL_Y + 124, `A job gets ${MAX_ATTEMPTS} attempts. A kill sends it back to open without spending one; a failure spends one, and the firm keeps what the work cost it.`, {
    kind: 'note',
    wrap: 320,
    lineHeight: 20,
  });

  // Inspection.
  panel(PX[1], 'Inspecting: every check must pass');
  CHECKS.forEach((c, i) => {
    const y = PANEL_Y + 34 + i * 24;
    s.line(PX[1], y - 5, PX[1] + 10, y - 5, 'l-strong');
    s.text(PX[1] + 18, y, CHECK_LABEL[c], { kind: 'note', keys: [`check:${c}`] });
  });
  s.text(PX[1], PANEL_Y + 34 + CHECKS.length * 24 + 10, `${CHECK_STATUS_LABEL.skipped}. ${CHECK_STATUS_LABEL.preexisting}.`, {
    kind: 'figure',
    keys: ['checkstatus:skipped', 'checkstatus:preexisting'],
    wrap: 330,
    lineHeight: 16,
  });

  // Shipping.
  panel(PX[2], 'Shipping: one of two ways');
  SHIP_MODES.forEach((m, i) => {
    const y = PANEL_Y + 34 + i * 70;
    s.text(PX[2], y, m.label, { kind: 'small', keys: [`move:${m.move}`] });
    s.text(PX[2], y + 21, m.note, { kind: 'note', wrap: 320, lineHeight: 19 });
  });

  // The floor.
  panel(PX[3], 'The floor it leaves');
  FLOOR_STATES.forEach((f, i) => {
    const y = PANEL_Y + 30 + i * 52;
    slab(s, PX[3], y, f);
    s.text(PX[3] + 82, y + 11, FLOOR_STATE_LABEL[f], { kind: 'note', keys: [`floor:${f}`], wrap: 230, lineHeight: 18 });
  });

  s.text(LEFT, H - 40, 'Drawn from the job states, the legal moves, the run stages and the checks in shared/types.ts and shared/market-rules.ts.', { kind: 'source' });

  return {
    name: 'floor',
    title: 'How a job becomes a floor',
    alt: 'How a job becomes a floor. A job moves along one line from proposed to merged; beneath it, every way off the line the code allows, back to open, to failed, halted, withdrawn or closed. Under the line, the run stages each job state holds, then the inspection checks, the two ways a pass ships, and the floor each ending leaves.',
    width: W,
    height: H,
    labels: s.labels,
    svg: s.svg(),
  };
}

/** A floor slab as the city draws it, flat: dark and waiting, lit, or struck to a scar. */
function slab(s: Sheet, x: number, y: number, state: 'waiting' | 'lit' | 'scar'): void {
  const w = 66;
  const h = 14;
  if (state === 'lit') {
    s.rect(x, y, w, h, 'f-accent');
    for (let i = 1; i < 8; i++) s.line(x + (w / 8) * i, y + 3, x + (w / 8) * i, y + h - 3, 'l-lit');
  } else if (state === 'waiting') {
    s.rect(x + 0.5, y + 0.5, w - 1, h - 1, 'slab');
  } else {
    s.rect(x + 0.5, y + 0.5, w - 1, h - 1, 'slab');
    for (let i = -h; i < w; i += 7) s.line(Math.max(x, x + i), y + Math.max(0, -i) + 0.5, Math.min(x + w, x + i + h), y + Math.min(h, w - i) - 0.5, 'l-strong');
    s.dot(x + w + 6, y + 2, 2.4, 'f-accent');
  }
}

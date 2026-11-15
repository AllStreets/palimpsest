/**
 * The school: the ledger to rows to the nets to the master; the master's
 * guess written before each of his decisions, agreement, the ask and the
 * grant; and, below, arenas to voyages and a LoRA, sealed races and
 * graduates.
 */
import type { NetName } from '../../shared/types.js';
import { AGREE, AUTONOMY_CHAIN, AUTONOMY_LABEL, NET_LABEL, NETS, SCHOOL_WORDS, WORK_KIND_LABEL, WORK_KINDS } from './data.js';
import { Sheet, type Diagram } from './sheet.js';

const W = 1600;
const H = 1300;

type Kind = (typeof AUTONOMY_CHAIN)[number];

export function school(): Diagram {
  const s = new Sheet(W, H);
  s.text(80, 92, 'How the school learns, and when the city may act', { kind: 'title' });

  // ------------------------------------------------------------ the ledger to the master
  const A = 168;
  s.text(80, A, 'What it learns from', { kind: 'head' });
  s.line(80, A + 18, W - 80, A + 18, 'l-rule');

  const R = 260;
  const ledger = s.entry(80, R, 220, 'The ledger', { note: 'Every bid, run, inspection, merge and decision, append only', keys: ['ledger'] });
  const rows = s.entry(350, R, 250, 'Rows', { note: SCHOOL_WORDS.rows, keys: ['rows'] });
  link(s, 300, ledger.rule, 350, rows.rule);

  // The nets, as a ruled table: name and what it learns.
  const NX = 690;
  const nets = NETS.filter((n) => n !== 'master');
  const netTop = R - 30;
  nets.forEach((n: NetName, i) => {
    const y = netTop + i * 32;
    s.text(NX + 18, y, NET_LABEL[n].name, { kind: 'small', keys: [`net:${n}`] });
    s.text(NX + 238, y, NET_LABEL[n].learns, { kind: 'note' });
  });
  const netBottom = netTop + (nets.length - 1) * 32;
  // A bracket gathers the rows into the nets, and the nets out to the master.
  s.path(`M${NX + 6},${netTop - 6} H${NX} V${netBottom + 4} H${NX + 6}`, 'l-strong');
  link(s, 600, rows.rule, NX - 2, rows.rule);
  const NR = 1150;
  s.path(`M${NR - 6},${netTop - 6} H${NR} V${netBottom + 4} H${NR - 6}`, 'l-strong');
  const master = s.entry(1220, R, 300, NET_LABEL.master.name, { note: `${NET_LABEL.master.learns}, from the nets’ outputs. It never learns from its own guesses`, keys: ['net:master'] });
  link(s, NR, master.rule, 1220, master.rule);
  s.text(NX, netBottom + 44, 'Each is trusted only when it beats its baseline on rows it never trained on, by an interval clear of zero.', { kind: 'figure' });

  // ------------------------------------------------------------ guess, decision, agreement, ask, grant, act
  const B = 520;
  s.text(80, B, 'When the city may act on its own', { kind: 'head' });
  s.line(80, B + 18, W - 80, B + 18, 'l-rule');

  const R2 = B + 92;
  const xs = [80, 320, 560, 840, 1060, 1300];
  const w = 200;
  const step = (x: number, k: Kind | 'agreement', ww = w) => {
    if (k === 'agreement') return s.entry(x, R2, ww, 'Agreement', { nameKind: 'small', note: SCHOOL_WORDS.agreement, keys: ['agreement'], noteWrap: ww });
    return s.entry(x, R2, ww, AUTONOMY_LABEL[k].name, { nameKind: 'small', note: AUTONOMY_LABEL[k].note, keys: [`ledger:${k}`], noteWrap: ww });
  };
  const guess = step(xs[0], 'master.predicted');
  const decision = step(xs[1], 'decision.resolved');
  const agree = step(xs[2], 'agreement', 240);
  const ask = step(xs[3], 'autonomy.asked', 180);
  const grant = step(xs[4], 'autonomy.granted', 200);
  const act = step(xs[5], 'autonomy.acted', 220);
  link(s, xs[0] + w, guess.rule, xs[1], decision.rule);
  link(s, xs[1] + w, decision.rule, xs[2], agree.rule);
  link(s, xs[2] + 240, agree.rule, xs[3], ask.rule);
  link(s, xs[3] + 180, ask.rule, xs[4], grant.rule);
  link(s, xs[4] + 200, grant.rule, xs[5], act.rule);

  // The master's line wraps down into the guess.
  const wrapY = (R + netBottom) / 2 + 150;
  s.path(`M1370,${master.bottom + 14} V${wrapY - 8} Q1370,${wrapY} 1362,${wrapY} H72 Q64,${wrapY} 64,${wrapY + 8} V${guess.rule - 8} Q64,${guess.rule} 72,${guess.rule} H78`, 'l-strong');
  s.arrow(78, guess.rule, 0, 'l-strong', 6);

  // Per kind of work.
  const kindsY = agree.bottom + 36;
  s.text(xs[2], kindsY, 'Counted for each kind of work:', { kind: 'figure' });
  WORK_KINDS.forEach((k, i) => s.text(xs[2] + 12, kindsY + 22 + i * 19, WORK_KIND_LABEL[k], { kind: 'figure', keys: [`kind:${k}`] }));

  // The branches: not yet, under the ask; suspended and revoked, under the act.
  const branch = (x: number, from: number, y: number, k: Kind, ww: number) => {
    s.path(`M${x - 12},${from + 14} V${y + 11} H${x - 2}`, 'l-strong');
    s.arrow(x - 2, y + 11, 0, 'l-strong', 5);
    return s.entry(x, y, ww, AUTONOMY_LABEL[k].name, { nameKind: 'small', note: AUTONOMY_LABEL[k].note, keys: [`ledger:${k}`], rule: 'l-rule' });
  };
  const below = Math.max(ask.bottom, grant.bottom, act.bottom) + 58;
  branch(xs[3] + 14, ask.bottom, below, 'autonomy.declined', 166);
  const sus = branch(xs[5] + 14, act.bottom, below, 'autonomy.suspended', 206);
  const rev = branch(xs[5] + 14, sus.bottom - 6, sus.bottom + 46, 'autonomy.revoked', 206);
  s.text(xs[5] + 14, rev.bottom + 30, `A grant he takes back is quiet for ${AGREE.quietDays} days.`, { kind: 'figure', wrap: 206, lineHeight: 17 });

  // ------------------------------------------------------------ arenas to graduates
  const C = 990;
  s.text(80, C, 'How it makes new agents', { kind: 'head' });
  s.line(80, C + 18, W - 80, C + 18, 'l-rule');
  const R3 = C + 110;
  const arena = s.entry(80, R3, 330, 'An arena', { note: SCHOOL_WORDS.arena.replace(/^An arena: /, 'From one of his repos: ').replace(/^./, (c) => c.toUpperCase()), keys: ['arena'] });
  const voyage = s.entry(520, R3 - 60, 300, 'A voyage', { note: SCHOOL_WORDS.voyage.replace(/^A voyage: /, '').replace(/^./, (c) => c.toUpperCase()) + ', bred on the breeding tasks', keys: ['voyage'] });
  const lora = s.entry(520, R3 + 60, 300, 'A LoRA', { note: SCHOOL_WORDS.lora.replace(/^A LoRA /, 'A small local coder taught ') , keys: ['lora'] });
  const race = s.entry(930, R3, 280, 'A sealed race', { note: SCHOOL_WORDS.sealed, keys: ['sealed'] });
  const grad = s.entry(1290, R3, 230, 'The roster', { note: SCHOOL_WORDS.graduate, keys: ['graduate'] });
  fork(s, 410, arena.rule, 520, voyage.rule, lora.rule);
  join(s, 820, voyage.rule, lora.rule, 930, race.rule);
  link(s, 1210, race.rule, 1290, grad.rule);

  s.text(80, H - 40, 'Drawn from the nets, the work kinds, the ledger’s autonomy kinds and the school’s rules in shared/school-rules.ts.', { kind: 'source' });

  return {
    name: 'school',
    title: 'How the school learns, and when the city may act',
    alt: 'How the school learns, and when the city may act. The ledger becomes rows, the rows train five nets, and the nets feed the master, which guesses whether he would approve. Its guess is written before each of his decisions; when it has agreed with him on 95% of his last 50 decisions of a kind, the city asks in his brief, and only his answer grants it. Under a grant the city acts only while the master is trusted and sure; an undo suspends the grant and a revert revokes it. Below, an arena from one of his repos feeds a voyage and a LoRA, each raced on sealed tasks, and a winner graduates to the roster.',
    width: W,
    height: H,
    labels: s.labels,
    svg: s.svg(),
  };
}

function link(s: Sheet, x1: number, y1: number, x2: number, y2: number): void {
  if (y1 === y2) s.line(x1, y1, x2 - 2, y2, 'l-ink');
  else s.path(`M${x1},${y1} H${(x1 + x2) / 2} V${y2} H${x2 - 2}`, 'l-ink');
  s.arrow(x2 - 2, y2, 0, 'l-ink', 6);
}

function fork(s: Sheet, x1: number, y: number, x2: number, ya: number, yb: number): void {
  const mx = (x1 + x2) / 2;
  s.path(`M${x1},${y} H${mx - 8} Q${mx},${y} ${mx},${y - 8} V${ya + 8} Q${mx},${ya} ${mx + 8},${ya} H${x2 - 2}`, 'l-ink');
  s.path(`M${mx - 8},${y} Q${mx},${y} ${mx},${y + 8} V${yb - 8} Q${mx},${yb} ${mx + 8},${yb} H${x2 - 2}`, 'l-ink');
  s.arrow(x2 - 2, ya, 0, 'l-ink', 6);
  s.arrow(x2 - 2, yb, 0, 'l-ink', 6);
}

function join(s: Sheet, x1: number, ya: number, yb: number, x2: number, y: number): void {
  const mx = (x1 + x2) / 2;
  s.path(`M${x1},${ya} H${mx - 8} Q${mx},${ya} ${mx},${ya + 8} V${y - 8} Q${mx},${y} ${mx + 8},${y} H${x2 - 2}`, 'l-ink');
  s.path(`M${x1},${yb} H${mx - 8} Q${mx},${yb} ${mx},${yb - 8} V${y + 8}`, 'l-ink');
  s.arrow(x2 - 2, y, 0, 'l-ink', 6);
}

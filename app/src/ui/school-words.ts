/**
 * The school screen's words (Phase 4 Task 30), kept free of the page so the
 * tests can read them. Every claim carries its number with its interval and
 * n; every empty state says why, in the engine's own words where it has
 * them (a thin net's cause, a gate's reason, a grant's sentence).
 */
import { AGREE, NET_MIN, SEALED_USES } from '../../../shared/school-rules.js';
import type { Agreement, GateState, Grant, Interval, NetCard, NetName, TrainKind, TrainState, VoyageView, WorkKind } from '../../../shared/types.js';
import { ago, plural } from './controls.js';
import { shortDate } from './story.js';

/** Labels a net needs before it reports anything: the training rows plus the held-out ones (ruling 11). */
const NEEDS = NET_MIN.train + NET_MIN.heldOut;

export const fixed = (x: number): string => x.toFixed(2);
/** A difference with its sign, a true minus for the negative. */
export const signed = (x: number): string => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(2)}`;

/** Ends a sentence the engine wrote without its full stop. */
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);
/** The engine's sentence lowered to follow a colon. */
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export type Metric = 'brier' | 'mae' | 'agreement' | 'sealed';

const METRIC_WORD: Record<Metric, string> = { brier: 'Brier', mae: 'Error', agreement: 'Agreement', sealed: 'Score' };
const METRIC_N: Record<Metric, string> = { brier: 'held-out row', mae: 'held-out row', agreement: 'decision', sealed: 'sealed task' };

/** "Brier 0.14, 95% interval 0.10 to 0.19, on 64 held-out rows". */
export function intervalText(i: Interval, metric: Metric): string {
  return `${METRIC_WORD[metric]} ${fixed(i.value)}, 95% interval ${fixed(i.lo)} to ${fixed(i.hi)}, on ${plural(i.n, METRIC_N[metric])}`;
}

/** "+0.14, 95% interval +0.06 to +0.22". */
export function diffText(d: { diff: number; lo: number; hi: number }): string {
  return `${signed(d.diff)}, 95% interval ${signed(d.lo)} to ${signed(d.hi)}`;
}

// ---------------------------------------------------------------- the nets

export const NET_LABEL: Record<NetName, string> = {
  'appraiser-pass': 'Appraiser, pass',
  'appraiser-cost': 'Appraiser, cost',
  router: 'Router',
  durability: 'Durability',
  triage: 'Triage',
  taste: 'Taste',
  master: 'Master',
};

/** What each net learns, for the row beneath its name. */
export const NET_LEARNS: Record<NetName, string> = {
  'appraiser-pass': 'whether an awarded bid will merge',
  'appraiser-cost': 'what an awarded bid will cost',
  router: 'which agent to send a job to',
  durability: 'whether a city merge will survive',
  triage: "what the morning's brief should lead with",
  taste: 'which of two UI changes you would keep',
  master: 'what you will decide',
};

/** The ledger's shorter line for a net that has a version: its standing and when, the numbers standing in their own cells. */
export function netRowLine(card: NetCard): string {
  const v = card.current;
  if (!v) return netLine(card);
  if (card.status === 'trusted') return `Trusted at v${v.version}, ${shortDate(v.at)}; ${plural(card.history.length, 'version')} so far.`;
  return netLine(card);
}

export const STATUS_WORD: Record<NetCard['status'], string> = { thin: 'thin', untrained: 'not trained yet', trained: 'trained, not trusted', trusted: 'trusted' };

/**
 * A net's standing in one line: a thin net its counts and cause ("18 of 40
 * labels. No city merge has had 30 days yet."), an untrained one the
 * engine's reason, a trained one why it is not trusted, a trusted one its
 * score with the interval, n and the baseline it beat.
 */
export function netLine(card: NetCard): string {
  const counts = card.reason ?? `${card.labels} of ${card.needs || NEEDS} labels`;
  switch (card.status) {
    case 'thin': {
      if (!card.cause) return stop(counts);
      // The engine's cause often carries the counts itself ("18 of 40 city merges have had 30 days or a revert"): said once.
      const m = /^(\d+) of (\d+)\b/.exec(counts);
      const repeats = m ? new RegExp(`^${m[1]} of ${m[2]}\\b`).test(card.cause) : false;
      return repeats ? stop(card.cause) : `${stop(counts)} ${stop(card.cause)}`;
    }
    case 'untrained':
      return stop(card.reason ?? 'Enough labels; not trained yet');
    case 'trained':
      return stop(card.reason ?? (card.current ? `v${card.current.version} does not beat its baseline on held-out rows` : 'Trained, not yet trusted'));
    case 'trusted': {
      const v = card.current;
      if (!v) return 'Trusted.';
      return `Trusted at v${v.version}: ${intervalText(v.score, v.metric)}, against a baseline of ${fixed(v.baseline.value)}.`;
    }
  }
}

// ---------------------------------------------------------------- the gate

/** "01:00" as "1:00"; "23:30" stays. */
const hour = (hhmm: string): string => hhmm.replace(/^0(\d)/, '$1');
const hm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * "Training waits: on battery." or "Training may run: on power in Low Power
 * mode, idle 22 minutes, inside 1:00 to 6:00." The window is the school's
 * setting, since the gate reads only whether it is inside it.
 */
export function gateLine(g: GateState, window?: { from: string; to: string }): string {
  if (!g.ok) return `Training waits: ${g.reason ?? 'the gate did not say why'}.`;
  const parts: string[] = [];
  parts.push(g.power === 'ac' ? (g.powerMode === 1 ? 'on power in Low Power mode' : 'on power') : g.power === 'battery' ? 'on battery' : 'the power source unread');
  if (g.idleMin !== null) parts.push(`idle ${plural(g.idleMin, 'minute')}`);
  if (g.trainNowUntil) parts.push(`on Train now until ${hm(g.trainNowUntil)}`);
  else if (g.inWindow) parts.push(window ? `inside ${hour(window.from)} to ${hour(window.to)}` : 'inside the window');
  return `Training may run: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------- the master and his kinds

export const KIND_LABEL: Record<WorkKind, string> = {
  'propose:harness': 'Harness proposals',
  'propose:readme-gap': 'README gap proposals',
  'merge:low': 'Low-tier merges',
  'merge:normal': 'Normal-tier merges',
  'merge:high': 'High-tier merges',
  'merge:ui': 'UI merges',
};

export function kindLabel(kind: WorkKind): string {
  return KIND_LABEL[kind] ?? kind;
}

export const SKEWED_LINE = 'You approve nearly all of these, so the master cannot show it knows better than that; this kind may never be offered.';
const NEEDS_LINE = `Autonomy needs ${AGREE.window} at ${Math.round(AGREE.rate * 100)}%.`;

/**
 * A kind's agreement over its window: the count, the rate with its interval,
 * and whether that is enough; the skewed kind says why it may never be offered.
 */
export function agreementLine(a: Agreement): string {
  if (a.skewed) return SKEWED_LINE;
  if (a.rows === 0) return 'No decision of this kind has had a prediction yet.';
  if (!a.rate) return `Agreed with you on ${a.agreed} of ${a.rows} decisions. ${a.eligible ? 'Enough for autonomy.' : NEEDS_LINE}`;
  return `Agreed with you on ${a.agreed} of the last ${a.rows} decisions: ${fixed(a.rate.value)}, 95% interval ${fixed(a.rate.lo)} to ${fixed(a.rate.hi)}. ${a.eligible ? 'Enough for autonomy.' : NEEDS_LINE}`;
}

const times = (n: number): string => (n === 1 ? 'once' : `${n} times`);

/** A grant's state in a sentence, the engine's own reason kept whole where it wrote one. */
export function grantLine(g: Grant, now = Date.now()): string {
  const when = shortDate(g.at);
  switch (g.state) {
    case 'asked':
      return `Asked ${ago(Date.parse(g.at), now)}; waiting on you.`;
    case 'granted':
      return `Granted by you on ${when}; the city has ${g.acted > 0 ? `acted on it ${times(g.acted)}` : 'not acted on it yet'}.`;
    case 'suspended': {
      const why = g.reason ? `: ${lower(stop(g.reason))}` : '.';
      return `Suspended by the school${why}${g.acted > 0 ? ` The city acted on it ${times(g.acted)} before.` : ''}`;
    }
    case 'revoked':
      if (g.by === 'revert') return `Revoked by your revert on ${when}${g.reason ? `: ${lower(stop(g.reason))}` : '.'}`;
      return `Taken back by you on ${when}${g.acted > 0 ? `, after the city acted on it ${times(g.acted)}` : ''}${g.quietUntil ? `; not asked again until ${shortDate(g.quietUntil)}` : ''}.`;
    case 'declined':
      return `Declined by you on ${when}${g.quietUntil ? `; not asked again until ${shortDate(g.quietUntil)}` : ''}.`;
  }
}

// ---------------------------------------------------------------- arenas, voyages, the LoRA

/** "11 of 100 verified changes", or that there are enough. */
export function loraLine(l: { examples: number; needs: number }): string {
  if (l.examples < l.needs) return `${l.examples} of ${l.needs} verified changes`;
  return `${l.examples} verified changes, enough to train (${l.needs} needed)`;
}

/** "sealed set used 3 of 10 times". */
export function sealedLine(info: { sealedUses: number }): string {
  if (info.sealedUses === 0) return `sealed set not yet used, ${SEALED_USES} uses allowed`;
  return `sealed set used ${info.sealedUses} of ${SEALED_USES} times`;
}

const place = (v: VoyageView): string => `generation ${v.generation} of ${v.of}, ${v.runs.done} of ${v.runs.of} runs`;

/** A voyage in one line: how far it has sailed, or why it waits, or what its champion claims. */
export function voyageLine(v: VoyageView): string {
  if (v.queued) return `Queued.${v.reason ? ` ${stop(v.reason)}` : ''}`;
  switch (v.status) {
    case 'sailing':
      return `Sailing: ${place(v)}. A voyage spans several nights.`;
    case 'paused':
      return `Paused at ${place(v)}${v.reason ? `: ${lower(stop(v.reason))}` : '.'}`;
    case 'done': {
      const head = `Done after ${plural(v.generation, 'generation')} and ${plural(v.runs.done, 'run')}.`;
      if (!v.champion) return `${head}${v.reason ? ` ${stop(v.reason)}` : ' No champion was kept.'}`;
      if (v.claim) return `${head} ${v.champion.name} beat every seeded local agent on the sealed tasks.`;
      return `${head} ${v.champion.name} makes no claim${v.reason ? `: ${lower(stop(v.reason))}` : '.'}`;
    }
    case 'failed':
      return `Failed at ${place(v)}${v.reason ? `: ${lower(stop(v.reason))}` : '.'}`;
    case 'capped':
      return `Stopped at the cap at ${place(v)}${v.reason ? `: ${lower(stop(v.reason))}` : '.'}`;
  }
}

// ---------------------------------------------------------------- training

export const TRAIN_KIND: Record<TrainKind, string> = { nets: 'The nets', lora: 'A LoRA', arena: 'An arena build', voyage: 'A voyage', eval: 'A sealed race' };

/** "A LoRA, paused: on battery. 350 of 600 steps, 50 lost to the pause, the optimizer reset." */
export function trainLine(t: TrainState): string {
  const why = t.reason && t.status !== 'done' && t.status !== 'running' ? `: ${lower(stop(t.reason))}` : '.';
  let s = `${TRAIN_KIND[t.kind] ?? t.kind}, ${t.status}${why}`;
  if (t.steps) {
    const bits = [`${t.steps.done} of ${t.steps.of} steps`];
    if (t.steps.lost > 0) bits.push(`${t.steps.lost} lost to the pause`);
    if (t.steps.optimizerReset) bits.push('the optimizer reset');
    s += ` ${bits.join(', ')}.`;
  }
  return s;
}

/** The base model's standing, and how his last download ended. */
export function downloadLine(l: { baseReady: boolean; download: { running: boolean; status: 'ready' | 'failed' | null; reason: string | null } | null }, baseModel: string): string {
  if (l.download?.running) return `Downloading the base model, ${baseModel}.`;
  const head = `The base model, ${baseModel}, is ${l.baseReady ? '' : 'not '}downloaded.`;
  if (!l.baseReady && l.download?.status === 'failed') return `${head} The last download failed${l.download.reason ? `: ${lower(stop(l.download.reason))}` : '.'}`;
  return head;
}

/** The trainer's standing: ready with its versions, or the engine's reason. */
export function trainerLine(t: { ready: boolean; reason: string | null; arch: string | null; mlx: string | null; mlxLm: string | null; pinned: boolean }): string {
  if (!t.ready) return stop(t.reason ?? 'The trainer is not set up on this Mac');
  return `The trainer is ready: ${t.arch ?? 'arch unread'}, mlx ${t.mlx ?? '?'}, mlx-lm ${t.mlxLm ?? '?'}, ${t.pinned ? 'the pinned versions' : 'not the pinned versions'}.`;
}

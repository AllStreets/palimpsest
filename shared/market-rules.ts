/**
 * The market's rules as pure functions and constants: tiers, the award, the
 * reputation score and era, firm money and the job transition table. Shared
 * by the engine and the UI; imports nothing from engine/.
 */
import type { Era, JobStatus, Repo, RepoChecks, Reputation, Settings, Tier } from './types.js';

/** A job's value (the bid ceiling) by tier, in credits (ruling 3). */
export const TIER_VALUE: Record<Tier, number> = { low: 20, normal: 60, high: 150 };

/** The three issue labels that post a job: normal, low and high. */
export function TIER_LABELS(base = 'palimpsest'): [string, string, string] {
  return [base, `${base}:low`, `${base}:high`];
}

const TIER_ORDER: Tier[] = ['low', 'normal', 'high'];

/** The job's tier from an issue's labels: null when it carries no tier label; with more than one, the highest wins. */
export function tierFromLabels(labels: string[], base = 'palimpsest'): Tier | null {
  const [normal, low, high] = TIER_LABELS(base);
  let best = -1;
  for (const label of labels) {
    const tier: Tier | null = label === high ? 'high' : label === normal ? 'normal' : label === low ? 'low' : null;
    if (tier) best = Math.max(best, TIER_ORDER.indexOf(tier));
  }
  return best < 0 ? null : TIER_ORDER[best];
}

/** The overclaim a firm with no resolved bids is charged (ruling 4). */
export const NEW_FIRM_OVERCLAIM = 0.15;
/** How many of a firm's most recent resolved bids its overclaim is measured over. */
export const OVERCLAIM_WINDOW = 20;

export const START_BALANCE = 300;
export const HIRE_FEE = 80;
export const REVIEWER_SHARE = 0.05;
export const MAX_ATTEMPTS = 2;
/** Dollars of Anthropic API spend to credits, for the firm's books (ruling 18). */
export const CREDITS_PER_USD = 20;
/** Continuous hours below zero before a firm is bankrupt (ruling 6). */
export const BANKRUPT_HOURS = 72;

/** Rounds away floating point noise (0.9 * 0.8 is 0.7200000000000001), so the books show the numbers people expect. */
function tidy(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The calibrated pass probability: stated confidence discounted by the firm's overclaim. */
export function calibrated(confidence: number, overclaim: number): number {
  return tidy(clamp01(confidence) * (1 - clamp01(overclaim)));
}

/** Expected value of a bid to the city: calibrated pass probability times the job's value, minus the price. */
export function expectedValue(calibratedP: number, value: number, price: number): number {
  return tidy(calibratedP * value - price);
}

/**
 * Mean of (confidence - outcome) over the last OVERCLAIM_WINDOW resolved bids
 * (oldest first, most recent last), clamped to [0, 1]. NEW_FIRM_OVERCLAIM when there are none.
 */
export function overclaimOf(resolved: Array<{ confidence: number; passed: boolean }>): number {
  const recent = resolved.slice(-OVERCLAIM_WINDOW);
  if (recent.length === 0) return NEW_FIRM_OVERCLAIM;
  const sum = recent.reduce((s, r) => s + (r.confidence - (r.passed ? 1 : 0)), 0);
  return tidy(clamp01(sum / recent.length));
}

/** score = 0.5 * passRate + 0.3 * (1 - brier) + 0.2 * durability, each unknown term at 0.5 (ruling 5). */
export function reputationScore(r: Pick<Reputation, 'passRateAll' | 'brier' | 'durability'>): number {
  const pass = r.passRateAll ?? 0.5;
  const calibration = r.brier === null ? 0.5 : 1 - r.brier;
  const durability = r.durability ?? 0.5;
  return tidy(0.5 * pass + 0.3 * calibration + 0.2 * durability);
}

export const ERA_ORDER: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
/** Lower bound of each era's half-open score range: [0, 0.35) stone ... [0.8, 1] scifi. */
const ERA_FLOORS: Array<[number, Era]> = [
  [0.8, 'scifi'],
  [0.65, 'titanium'],
  [0.5, 'glass'],
  [0.35, 'brick'],
  [0, 'stone'],
];

/** The era a score earns, on half-open ranges, capped at the agent's capability era. */
export function eraForScore(score: number, capability: Era): Era {
  const earned = ERA_FLOORS.find(([min]) => score >= min)?.[1] ?? 'stone';
  return ERA_ORDER.indexOf(earned) <= ERA_ORDER.indexOf(capability) ? earned : capability;
}

/** True once a firm has been negative continuously for BANKRUPT_HOURS. */
export function isBankrupt(negativeSince: string | null, now: number | Date = Date.now()): boolean {
  if (!negativeSince) return false;
  const t = typeof now === 'number' ? now : now.getTime();
  return t - Date.parse(negativeSince) >= BANKRUPT_HOURS * 3600_000;
}

/** A dark tower's sale price in credits. */
export function salePrice(floors: number): number {
  return 2 * floors + 20;
}

/** Hiring needs an active firm, a balance above 400, more open jobs than idle agents and fewer than four towers in the quarter. */
export function canHire(balance: number, openJobs: number, idleAgents: number, towers: number, status: 'active' | 'bankrupt'): boolean {
  return status === 'active' && balance > 400 && openJobs > idleAgents && towers < 4;
}

/** The market fields a repo starts with, also filled in for rows written before Phase 2. */
export function repoMarketDefaults(): Pick<Repo, 'market' | 'label' | 'checks' | 'halted' | 'strikes' | 'joinedAt' | 'auditedAt'> {
  return { market: false, label: 'palimpsest', checks: null, halted: null, strikes: 0, joinedAt: null, auditedAt: null };
}

/** The registries a job may reach while it installs and works, by the repo's ecosystems (ruling 21). */
export const REGISTRY_HOSTS: Record<'npm' | 'python' | 'rust' | 'go', string[]> = {
  npm: ['registry.npmjs.org'],
  python: ['pypi.org', 'files.pythonhosted.org'],
  rust: ['index.crates.io', 'static.crates.io', 'crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
};

/** Why push mode cannot be on (ruling 23). */
export const PUSH_MODE_NEEDS = 'Push mode needs both a test command and a build command on this repo.';

/** Push mode needs both a test and a build command: null when the checks have both, else the reason. Shared by the engine's gate and the Repos page. */
export function pushModeRefusal(checks: Pick<RepoChecks, 'test' | 'build'> | null): string | null {
  return checks?.test && checks.build ? null : PUSH_MODE_NEEDS;
}

/** Every move a job may make. Anything not listed is refused. */
export const LEGAL_MOVES: Record<JobStatus, JobStatus[]> = {
  proposed: ['open', 'withdrawn'],
  open: ['bidding', 'withdrawn', 'halted'],
  bidding: ['awarded', 'open', 'withdrawn', 'halted'], // open: no positive bid this window
  awarded: ['running', 'open', 'failed', 'withdrawn', 'halted'], // open: killed before it started; failed: crashed in preparing or installing
  running: ['inspecting', 'open', 'failed', 'withdrawn', 'halted'], // open: killed (no attempt); failed: crashed or capped
  inspecting: ['shipping', 'failed', 'open', 'withdrawn', 'halted'], // open: killed mid-inspection
  shipping: ['waiting', 'merged', 'failed', 'open', 'halted'], // open: push rejected twice, no scar
  waiting: ['merged', 'closed', 'withdrawn', 'halted'],
  failed: ['open'], // only while attempts < MAX_ATTEMPTS
  halted: ['open', 'waiting', 'withdrawn'], // resume: back to waiting if halted from waiting (PR still open), else open (ruling 30)
  merged: [],
  closed: [],
  withdrawn: [],
};

export function legalMove(from: JobStatus, to: JobStatus): boolean {
  return LEGAL_MOVES[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------- Phase 3: the audit, the brief, milestones and the tour

/** Credits an audit is assumed to cost when it takes its lease (Phase 3 ruling 5). */
export const AUDIT_ESTIMATE = 20;
/** The most findings one audit keeps, and the most evidence lines per finding (ruling 15). */
export const AUDIT_MAX_FINDINGS = 60;
export const AUDIT_MAX_EVIDENCE = 3;
/** The longest each string of the audit's answer may be, in characters. */
export const AUDIT_TEXT_CAPS = { claim: 400, note: 300, title: 120, body: 4000 } as const;
/** How much README and docs text the prompt carries, in characters, by the model's kind (ruling 1). */
export const AUDIT_READ_CAPS = { claude: 200_000, local: 24_000 } as const;
/** The most characters one tool result may carry to a local model. */
export const AUDIT_LOCAL_RESULT = 8_000;
/** The audit session's turn and wall caps, by the model's kind. */
export const AUDIT_CAPS = { claude: { maxTurns: 60, maxMinutes: 25 }, local: { maxTurns: 40, maxMinutes: 25 } } as const;
/** Days without a floor before a repo is quiet; the first merge after lights it for LIGHTS_DAYS (decision 4). */
export const QUIET_DAYS = 90;
export const LIGHTS_DAYS = 7;
/** A firm's first PR keeps its ribbon until this many days after it merges. */
export const RIBBON_DAYS = 7;
/** The week tour: at most eight stops, six seconds each, four to glide between, three at the exchange each end; fewer than two stops is no tour (ruling 12). */
export const TOUR = { maxStops: 8, dwell: 6, glide: 4, exchange: 3, minStops: 2 } as const;

/** The harness proposal's key on a repo. */
export function HARNESS_KEY(repo: string): string {
  return `${repo}#harness`;
}

/**
 * SHA-1 in plain JavaScript, so the key is the same in the engine and the
 * app (shared/ runs in the browser, where node:crypto is not available).
 */
function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** The claim as the key hashes it: lower case, one space between words, trimmed. */
export function normaliseClaim(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A proposal's key: `<repo>#<sha1 of the normalised claim>[:12]` (ruling 4). The key carries nothing of the claim itself. */
export function proposalKey(repo: string, claim: string): string {
  return `${repo}#${sha1Hex(normaliseClaim(claim)).slice(0, 12)}`;
}

/**
 * The five-hour cap that holds on `day` (YYYY-MM-DD, local): today's limit
 * when he set one for that day, clamped to [5, hardStopPct - 5] and allowed
 * above `dayCapPct`, else `dayCapPct` (ruling 10, decision 7).
 */
export function todayCap(settings: Pick<Settings, 'dayCapPct' | 'hardStopPct' | 'todayCapPct'>, day: string): number {
  const t = settings.todayCapPct;
  if (!t || t.day !== day || typeof t.pct !== 'number' || !Number.isFinite(t.pct)) return settings.dayCapPct;
  const ceiling = Math.max(5, settings.hardStopPct - 5);
  return Math.min(ceiling, Math.max(5, t.pct));
}

/**
 * The parameter tag of an Ollama model name, in billions: `qwen3-coder:30b-a3b`
 * is 30, `qwen2.5-coder:7b` is 7, `qwen3:1.7b` is 1.7, a name without a tag is 0.
 * The first tag after the colon (or in the name) counts; an `a3b` active-parameter
 * tag does not outrank the total.
 */
export function localSize(name: string): number {
  const tag = name.toLowerCase().split(':')[1] ?? name.toLowerCase();
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?=$|[^a-z0-9])/.exec(tag) ?? /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?=$|[^a-z0-9])/.exec(name.toLowerCase());
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------- scope globs

/** Paths no job may change, whatever its scope; the audit drops them from a proposal's scope too. */
export const DENY_SCOPE = ['.github/workflows/**', '.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '.claude/**', '.git/**'];

/** A glob as a whole-path regex: `**` crosses folders (dot folders too), `*` and `?` stay in one, `{a,b}` alternates. */
export function globRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  let depth = 0;
  const g = glob.replace(/^\.\//, '').replace(/^\/+/, '');
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        const atStart = i === 0 || g[i - 1] === '/';
        if (atStart && slashAfter) {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      re += '(?:';
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      re += ')';
      depth -= 1;
    } else if (ch === ',' && depth > 0) re += '|';
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}${')'.repeat(depth)}$`);
}

const denyRes = DENY_SCOPE.map((g) => ({ g, re: globRegex(g), anywhere: !g.includes('/') }));

/** The last segment of a slash path (no `node:path`, so the app can import this file). */
function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** The deny pattern `path` matches, or null. A pattern without a slash matches the file name at any depth; `.git` and `.claude` folders are out at any depth. */
export function denied(path: string): string | null {
  const parts = path.split('/');
  if (parts.includes('.git')) return '.git/**';
  if (parts.slice(0, -1).includes('.claude')) return '.claude/**';
  for (const d of denyRes) if (d.re.test(path) || (d.anywhere && d.re.test(lastSegment(path)))) return d.g;
  return null;
}

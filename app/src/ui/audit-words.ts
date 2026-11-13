/**
 * The audit report's words (Phase 3 Task 10), kept free of the page so the
 * tests can read them: each verdict as a word and a drawn mark, the lead in
 * the same sentence the engine's page opens with, evidence as `file:line`
 * linked only to GitHub at the audited commit, where a proposal's job
 * stands, when "Propose again" may stand beside it, and why "Audit the
 * README" is held.
 */
import type { Audit, AuditTrigger, Evidence, Job, Verdict } from '../../../shared/types.js';
import { cleanText } from './board.js';

export type VerdictMark = 'full' | 'half' | 'empty' | 'hatched' | 'struck';

const WORDS: Record<Verdict, string> = { REAL: 'real', PARTIAL: 'partial', MISSING: 'missing', STUBBED: 'stubbed', BROKEN: 'broken' };
const MARKS: Record<Verdict, VerdictMark> = { REAL: 'full', PARTIAL: 'half', MISSING: 'empty', STUBBED: 'hatched', BROKEN: 'struck' };
const ORDER: Verdict[] = ['REAL', 'PARTIAL', 'MISSING', 'STUBBED', 'BROKEN'];

/** The verdict as it is read aloud and set in small capitals: real, partial, missing, stubbed, broken. */
export function verdictWord(v: Verdict): string {
  return WORDS[v] ?? String(v).toLowerCase();
}

/** The verdict's drawn mark: a full square, half of one, an empty one, a hatched one, a struck one. */
export function verdictMark(v: Verdict): VerdictMark {
  return MARKS[v] ?? 'empty';
}

const listOf = (parts: string[]): string => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

/**
 * The lead, word for word as the audit page opens (engine/audit/schema.ts):
 * "Of 14 claims in the README, 8 are real, 2 partial, 3 missing and 1
 * broken." with a line for unverified findings, and "No README to check."
 * for none; for an audit that did not finish, how it ended.
 */
export function leadOf(a: Pick<Audit, 'status' | 'findings' | 'claimsRead' | 'endedReason'>): string {
  const n = a.findings.length;
  if (a.status !== 'done') {
    const reason = cleanText(a.endedReason ?? '', 400).replace(/[.!?]$/, '');
    const found = n ? ` It had marked ${n} ${n === 1 ? 'claim' : 'claims'} before it ended.` : '';
    return `The audit ended ${a.status}${reason ? `: ${reason}` : ''}.${found} Nothing was proposed.`;
  }
  if (n === 0) return a.claimsRead === 0 ? 'No README to check.' : `Of ${a.claimsRead} ${a.claimsRead === 1 ? 'claim' : 'claims'} in the README, none could be checked against the code.`;
  const parts: string[] = [];
  for (const v of ORDER) {
    const c = a.findings.filter((f) => f.verdict === v).length;
    if (c) parts.push(parts.length ? `${c} ${WORDS[v]}` : `${c} ${c === 1 ? 'is' : 'are'} ${WORDS[v]}`);
  }
  const total = Math.max(a.claimsRead, n);
  const u = a.findings.filter((f) => f.unverified).length;
  const tail = u ? ` ${u === 1 ? 'One finding cites' : `${u} findings cite`} nothing found at the base commit and ${u === 1 ? 'is' : 'are'} unverified.` : '';
  return `Of ${total} ${total === 1 ? 'claim' : 'claims'} in the README, ${listOf(parts)}.${tail}`;
}

/** Where an audit not yet ended stands, in a sentence; null once it has ended. */
export function auditStage(a: Pick<Audit, 'status' | 'waitingReason' | 'model'>): string | null {
  switch (a.status) {
    case 'waiting': {
      const why = cleanText(a.waitingReason ?? '', 200);
      return why ? `Waiting: ${why.replace(/[.!?]?$/, '.')}` : 'Waiting to start.';
    }
    case 'preparing':
      return 'Cloning the repo at its base commit.';
    case 'installing':
      return 'Installing what its checks need.';
    case 'reading':
      return `Reading the README against the code${a.model ? `, on ${cleanText(a.model, 60)}` : ''}.`;
    default:
      return null;
  }
}

/** Waiting or under way: the repo may not start another. */
export const OPEN_STATUSES = new Set(['waiting', 'preparing', 'installing', 'reading']);

/** Why "Audit the README" is held: the reason while an audit waits or reads, else null. */
export function auditHeld(audits: Array<Pick<Audit, 'status' | 'waitingReason'>>): string | null {
  const open = audits.find((a) => OPEN_STATUSES.has(a.status));
  if (!open) return null;
  if (open.status === 'waiting') {
    const why = cleanText(open.waitingReason ?? '', 200).replace(/^waiting\s+/i, '');
    return why ? `An audit is waiting ${why.replace(/[.!?]?$/, '.')}` : 'An audit is waiting to start.';
  }
  return open.status === 'reading' ? 'An audit is reading the code now.' : 'An audit is under way now.';
}

/** A piece of evidence as it is cited: `src/a.ts:12`, or the file alone. */
export function evidenceText(e: Pick<Evidence, 'file' | 'line'>): string {
  return e.line === null ? e.file : `${e.file}:${e.line}`;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * The evidence on GitHub at the commit the audit read: `blob/<sha>/<file>#L<line>`.
 * Null for anything that is not a plain relative path in the repo (an
 * absolute path, `..`, a backslash, a scheme), for a repo name that is not
 * an owner and a name, and for a missing or non-hex commit. The model wrote
 * these paths, so nothing else ever becomes a link.
 */
export function evidenceHref(repo: string, sha: string | null, e: Pick<Evidence, 'file' | 'line'>): string | null {
  if (!sha || !COMMIT.test(sha)) return null;
  const rp = repo.split('/');
  if (rp.length !== 2 || !rp.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return null;
  const file = e.file;
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(file) || /[\u0000-\u001f\u007f]/.test(file)) return null;
  const parts = file.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const line = typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0 ? `#L${e.line}` : '';
  return `https://github.com/${rp[0]}/${rp[1]}/blob/${sha}/${parts.map(encodeURIComponent).join('/')}${line}`;
}

const STANDING: Partial<Record<Job['status'], string>> = {
  proposed: 'waiting on you',
  open: 'accepted, on the board',
  bidding: 'accepted, taking bids',
  awarded: 'accepted, being built',
  running: 'accepted, being built',
  inspecting: 'accepted, with the inspectors',
  shipping: 'accepted, being shipped',
  waiting: 'pull request open',
  merged: 'merged',
  failed: 'failed',
  closed: 'closed without merging',
  halted: 'halted',
};

/** Where a proposal's job stands, in a few words; "not posted" when it has none. */
export function proposalWord(j: Pick<Job, 'status' | 'withdrawnBy'> | null): string {
  if (!j) return 'not posted';
  if (j.status === 'withdrawn') return j.withdrawnBy === 'him' ? 'dismissed' : 'withdrawn';
  return STANDING[j.status] ?? j.status;
}

/**
 * Whether "Propose again" stands beside a job: one the city proposed (a
 * harness or an audit's proposal, with a key) that merged or that he
 * dismissed, and that is still the newest job on its key (`jobs` are the
 * repo's jobs as last read).
 */
export function canProposeAgain(j: Job, jobs: Job[]): boolean {
  if (!j.key || (j.source !== 'harness' && j.source !== 'proposal')) return false;
  if (j.status !== 'merged' && !(j.status === 'withdrawn' && j.withdrawnBy === 'him')) return false;
  return !jobs.some((o) => o.id !== j.id && o.key === j.key && !(o.status === 'withdrawn' && o.withdrawnBy === 'city') && o.postedAt > j.postedAt);
}

/** What each verdict means, as the audit's rules define it (Phase 3 ruling 2). */
export const VERDICT_MEANING: Record<Verdict, string> = {
  REAL: 'the code does it, and a test shows it',
  PARTIAL: 'the code does some of it; a named part is absent or untested',
  MISSING: 'nothing in the code does it',
  STUBBED: 'a function stands, but returns a fixed or placeholder value, or nothing reaches it',
  BROKEN: 'it is wired, but a test fails, a type error stops it, or the audit’s own run of it fails',
};

/**
 * What a proposal's body says to build, between "What to build:" and
 * "Accepted when:" (engine/audit/proposals.ts writes the body so), and
 * whether it was proposed again after a merge that did not close it. Null
 * for a body without that section (an issue, the harness). The claim and
 * the evidence the body opens with stand above it on the page already.
 */
export function whatToBuild(body: unknown): { again: boolean; text: string } | null {
  if (typeof body !== 'string') return null;
  const src = body.replace(/\r\n?/g, '\n');
  const m = /(?:^|\n)What to build:\n([\s\S]*?)(?:\n\s*\nAccepted when:[\s\S]*)?$/.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  if (!text) return null;
  return { again: /(?:^|\n)proposed again: the merge did not close it(?:\n|$)/.test(src.slice(0, m.index + 1)), text };
}

/** Why the audit ran, as the audit page's line under its title says it. */
export function auditedBecause(trigger: AuditTrigger): string {
  return trigger === 'connect' ? 'audited by itself when its market opened' : 'audited when you asked';
}

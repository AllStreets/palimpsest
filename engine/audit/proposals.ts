/**
 * Proposals from an audit (Phase 3 ruling 4): every verified gap a done
 * audit found, whose finding carries a proposal, becomes one `proposed` job
 * that waits for his click. The key rule keeps it to once: a key with a job
 * in any status (a dismissal by him included) is not proposed again, and a
 * merged key only while the next audit still finds the claim MISSING or
 * BROKEN. Nothing here bids, writes GitHub or opens a job; the proposal's
 * text is a model's reading of his README, so it is redacted and capped and
 * the body opens with CITY_MARKER (`postProposal`), and its scope goes
 * through the deny list again.
 */
import type { Audit, Finding, Job } from '../../shared/types.js';
import { subscribe } from '../events.js';
import { keyTaken, plain, postProposal, redact, reproposeJob } from '../market/jobs.js';
import { audit as storedAudit, saveAudit } from './store.js';

/** The line a body carries when a merged job's claim is still missing or broken. */
export const PROPOSED_AGAIN = 'proposed again: the merge did not close it';

/** The verdicts under which a merged key is proposed once more. */
const STILL_OPEN = new Set(['MISSING', 'BROKEN']);

/**
 * Posts a proposed job for each finding of `a` that may carry one and whose
 * key is free, writes each job's id back into the stored audit's finding
 * and returns the jobs posted, in finding order. An audit not `done`, a
 * finding without a proposal, an unverified one, or one already posted
 * (`proposal.jobId` set) posts nothing. Safe to call again for the same
 * audit: the write-back and the key rule make the second call a no-op.
 */
export function proposeFromAudit(a: Audit): Job[] {
  if (a.status !== 'done') return [];
  const current = storedAudit(a.id) ?? a;
  const posted: Job[] = [];
  let changed = false;
  const findings: Finding[] = current.findings.map((f) => {
    const p = f.proposal;
    if (!p || p.jobId || f.unverified) return f;
    const held = keyTaken(current.repo, p.key);
    let again = false;
    if (held) {
      if (held.status !== 'merged' || !STILL_OPEN.has(f.verdict)) return f;
      again = true;
    }
    const job = postProposal({
      repo: current.repo,
      title: p.title,
      body: bodyOf(f, again),
      scope: p.scope,
      acceptance: p.acceptance,
      tier: p.tier,
      key: p.key,
      source: 'proposal',
      proposal: { auditId: current.id, findingId: f.id },
    });
    posted.push(job);
    changed = true;
    return { ...f, proposal: { ...p, jobId: job.id } };
  });
  if (changed) saveAudit({ ...current, findings });
  return posted;
}

/**
 * His "Propose again" on a merged or dismissed proposal (or harness job):
 * a new `proposed` job on the same terms and key (`reproposeJob`), and for a
 * proposal its audit's finding names the new job, as replay learns it from
 * `job.proposed`.
 */
export function proposeAgain(jobId: string): Job {
  const next = reproposeJob(jobId);
  const p = next.proposal;
  const a = p ? storedAudit(p.auditId) : null;
  if (a && p) {
    const findings = a.findings.map((f) => (f.id === p.findingId && f.proposal ? { ...f, proposal: { ...f.proposal, jobId: next.id } } : f));
    saveAudit({ ...a, findings });
  }
  return next;
}

/**
 * The job's body, written for a firm to bid on: the claim and where the
 * README makes it, the verdict, the evidence as `file:line` with its note,
 * what the audit says to build, and the acceptance as checkboxes. Every
 * piece is the model's text, so each is redacted here; `postProposal`
 * redacts and caps the whole once more.
 */
function bodyOf(f: Finding, again: boolean): string {
  const where = f.source.line === null ? f.source.file : `${f.source.file}:${f.source.line}`;
  const lines: string[] = [];
  if (again) lines.push(PROPOSED_AGAIN, '');
  lines.push(`Claim: "${plain(f.claim, 400)}" (${redact(where)})`, `Verdict: ${f.verdict}${f.tested ? ', tested' : ', untested'}`, '');
  lines.push('Evidence:');
  for (const e of f.evidence) {
    const at = e.line === null ? e.file : `${e.file}:${e.line}`;
    lines.push(`- ${redact(at)}${e.note ? `: ${plain(e.note, 300)}` : ''}${e.verified ? '' : ' (unverified)'}`);
  }
  const what = redact(f.proposal?.body ?? '').trim();
  if (what) lines.push('', 'What to build:', what);
  lines.push('', 'Accepted when:');
  for (const line of f.proposal?.acceptance ?? []) lines.push(`- [ ] ${plain(line, 400)}`);
  return lines.join('\n');
}

/**
 * Subscribes to the bus and proposes from every audit that ends `done`.
 * Returns the unsubscribe. A failure to propose is logged and never stops
 * the audit's end or the next event.
 */
export function installProposals(): () => void {
  return subscribe((e) => {
    if (e.type !== 'audit.ended') return;
    const a = (e.data as { audit?: Audit } | null)?.audit;
    if (!a || a.status !== 'done') return;
    try {
      proposeFromAudit(a);
    } catch (err) {
      console.error(`palimpsest: the audit ${a.id} could not propose: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

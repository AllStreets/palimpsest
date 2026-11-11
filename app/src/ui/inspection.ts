import type { CheckView, InspectionView, JobDetail } from '../../../shared/types';
import { api, ApiError, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { cleanText, money } from './board';
import { el } from './controls';
import { CHECK_WORDS, cleanLog, duration, redactLog, verdict } from './detail';
import { coalesce, detailSheet, keyedSlot, namesOf, pageLink, secHead, setTrail, statusMark } from './pages';
import './market.css';

export interface InspectionPage {
  show(id: string): void;
  hide(): void;
}

const shortName = (fullName: string): string => fullName.split('/')[1] ?? fullName;
/** The order the guild runs its checks in. */
const ORDER = ['install', 'test', 'typecheck', 'lint', 'build', 'scope', 'review', 'design'];

/**
 * An inspection report (#/inspections/:id): the verdict, the checks as a
 * ruled table (each a word and a small shape, its time, and a fold to its
 * log), the reviewer's notes and concerns, the scope, and the design
 * judgement with the before and after screenshots side by side per route.
 */
export function createInspectionPage(parent: HTMLElement, opts: { listen(fn: (e: EngineEvent) => void): () => void; onDismiss(): void }): InspectionPage {
  const sheet = detailSheet(parent, 'insppage', opts.onDismiss);
  const body = sheet.body;
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  body.append(trouble);
  const slots = { checks: keyedSlot(body), review: keyedSlot(body), scope: keyedSlot(body), design: keyedSlot(body), cost: keyedSlot(body) };

  let id: string | null = null;
  let insp: InspectionView | null = null;
  let job: JobDetail | null = null;
  let names = namesOf([]);
  let unlisten: (() => void) | null = null;
  const openLogs = new Set<string>();

  const read = coalesce(async () => {
    const want = id;
    if (!want) return;
    try {
      const i = await api.inspection(want);
      if (want !== id) return;
      insp = i;
      const [jd, fs] = await Promise.all([api.job(i.jobId).catch(() => null), api.firms().catch(() => [])]);
      if (want !== id) return;
      job = jd;
      if (fs.length) names = namesOf(fs);
      trouble.hidden = true;
    } catch (err) {
      if (want !== id) return;
      trouble.textContent = err instanceof ApiError && err.status === 404 ? 'There is no such inspection.' : `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (e.type === 'engine.reconnected') return read();
    if (e.type === 'agent.hired' || e.type === 'firm.bankrupt') read();
  }

  // ---------------------------------------------------------------- the checks

  function checkRow(c: CheckView): HTMLElement[] {
    const words = CHECK_WORDS[c.name] ?? { name: c.name, what: '' };
    const tr = el('tr', `check-row s-${c.status}`);
    tr.dataset.check = c.name;
    const name = el('td', 'c-name');
    name.append(el('span', 'check-name', words.name));
    if (words.what) name.title = words.what;
    const detail = el('td', 'c-detail');
    const full = cleanLog(redactLog(c.detail ?? '')).trim();
    // The review's own words are read in full under The reviewer; the table says only how it came out.
    const first = c.name === 'review' ? (c.status === 'pass' ? 'Approved the change.' : 'Asked for changes; the concerns are below.') : cleanText(c.detail, 200);
    detail.append(el('span', 'check-detail', first || (c.status === 'skipped' ? 'Not run.' : '')));
    const more = !!c.log || (c.name !== 'review' && full.replace(/\s+/g, ' ') !== first);
    if (c.testsRun !== null && c.testsRun !== undefined) detail.append(el('span', 'check-tests', `${c.testsRun} tests`));
    const status = el('td', 'c-status');
    status.append(statusMark(c.status));
    const time = el('td', 'c-time', duration(c.durationMs));
    const fold = el('td', 'c-fold');
    const open = more && openLogs.has(c.name);
    if (more) {
      const btn = el('button', 'check-log-btn');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the ${words.name.toLowerCase()} ${c.log ? 'log' : 'detail'}`);
      const ico = el('i', 'log-fold');
      ico.setAttribute('aria-hidden', 'true');
      btn.append(ico, document.createTextNode(c.log ? 'Log' : 'More'));
      btn.addEventListener('click', () => {
        if (openLogs.has(c.name)) openLogs.delete(c.name);
        else openLogs.add(c.name);
        slots.checks('', () => null);
        render();
        body.querySelector<HTMLElement>(`.check-row[data-check="${c.name}"] .check-log-btn`)?.focus({ preventScroll: true });
      });
      fold.append(btn);
    }
    tr.append(status, name, detail, time, fold);
    const rows = [tr];
    if (open) {
      const lr = el('tr', 'check-log-row');
      const td = el('td');
      td.colSpan = 5;
      const log = c.log ? cleanLog(redactLog(c.log)) : '';
      if (full && full.replace(/\s+/g, ' ') !== first) td.append(el('pre', 'check-detail-full', full));
      if (log) td.append(el('pre', 'check-log', log));
      lr.append(td);
      rows.push(lr);
    }
    return rows;
  }

  function checksSection(i: InspectionView): HTMLElement {
    const sec = el('section', 'detail-sec insp-checks');
    const fails = i.checks.filter((c) => c.status === 'fail').length;
    sec.append(secHead('Checks', `${i.checks.length} checks${fails ? `, ${fails} failed` : ''}`));
    sec.append(el('p', 'jobs-key', 'A change passes only if every check holds: the repo’s own install, tests, type check, lint and build, the scope, a review by another firm, and for a change to the screens a design judgement. A missing check is skipped, never counted as a pass.'));
    const t = el('table', 'checks');
    t.append(el('caption', 'bids-cap', 'The checks this inspection ran'));
    const cols = el('colgroup');
    for (const c of ['status', 'name', 'detail', 'time', 'fold']) cols.append(el('col', `col-${c}`));
    t.append(cols);
    const thead = el('thead');
    const hr = el('tr');
    for (const [text, cls] of [
      ['Result', 'c-status'],
      ['Check', 'c-name'],
      ['What it found', 'c-detail'],
      ['Took', 'c-time'],
      ['', 'c-fold'],
    ]) {
      const th = el('th', cls, text);
      th.scope = 'col';
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    const sorted = [...i.checks].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
    for (const c of sorted) tbody.append(...checkRow(c));
    t.append(thead, tbody);
    sec.append(t);
    return sec;
  }

  // ---------------------------------------------------------------- the reviewer

  function reviewSection(i: InspectionView): HTMLElement {
    const sec = el('section', 'detail-sec insp-review');
    const c = i.checks.find((x) => x.name === 'review');
    const who = i.reviewerAgentId ? `${names.agent(i.reviewerAgentId)} of ${names.firm(i.reviewerFirmId ?? '')}` : '';
    sec.append(secHead('The reviewer', who));
    if (!c) {
      const failedCheck = i.checks.some((x) => ['install', 'test', 'typecheck', 'lint', 'build'].includes(x.name) && x.status === 'fail');
      sec.append(el('p', 'detail-quiet', failedCheck ? 'No review: a check had already failed, so no reviewer’s time was spent on it.' : 'No review was made.'));
      return sec;
    }
    // "Name: concern one; concern two" as the guild records it.
    let said = cleanLog(redactLog(c.detail ?? '')).replace(/\s+/g, ' ').trim();
    if (i.reviewerAgentId) {
      const n = names.agent(i.reviewerAgentId);
      if (said.startsWith(`${n}:`)) said = said.slice(n.length + 1).trim();
    }
    const concerns = said.split(/;\s+/).map((s) => s.trim()).filter(Boolean);
    const verdictWord = c.status === 'pass' ? 'Approved the change.' : 'Asked for changes.';
    sec.append(el('p', `insp-review-verdict ${c.status}`, verdictWord));
    if (c.status === 'pass' || concerns.length <= 1) {
      sec.append(el('blockquote', 'insp-note', said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : 'No notes.'));
    } else {
      sec.append(el('p', 'insp-note-lead', 'Concerns'));
      const ol = el('ol', 'insp-concerns');
      for (const x of concerns) ol.append(el('li', '', `${x.charAt(0).toUpperCase()}${x.slice(1)}`));
      sec.append(ol);
    }
    return sec;
  }

  // ---------------------------------------------------------------- scope

  function scopeSection(i: InspectionView): HTMLElement {
    const sec = el('section', 'detail-sec insp-scope');
    const c = i.checks.find((x) => x.name === 'scope');
    const scope = job?.job.scope ?? [];
    sec.append(secHead('Scope', scope.length ? `${scope.length} ${scope.length === 1 ? 'path' : 'paths'}` : ''));
    const grid = el('div', 'insp-scope-grid');
    const allowed = el('div', 'insp-scope-col');
    allowed.append(el('h3', 'job-term-head', 'The job allows'));
    const ul = el('ul', 'job-globs');
    for (const g of scope.length ? scope : ['**']) ul.append(el('li', 'job-glob', g === '**' ? '** (the whole repo)' : cleanText(g, 200)));
    allowed.append(ul);
    const found = el('div', 'insp-scope-col');
    found.append(el('h3', 'job-term-head', c?.status === 'fail' ? 'Outside it' : 'The change'));
    if (!c) found.append(el('p', 'detail-quiet', 'Scope was not checked.'));
    else if (c.status === 'fail') {
      const list = el('ul', 'insp-out');
      for (const line of cleanLog(redactLog(c.detail ?? '')).split('\n').filter(Boolean)) {
        const m = /^(\S+) (is .*|changed .*|changes .*)$/.exec(line);
        const li = el('li');
        if (m) li.append(el('code', 'insp-out-path', m[1]), el('span', 'insp-out-why', ` ${m[2]}`));
        else li.append(document.createTextNode(line));
        list.append(li);
      }
      found.append(list);
    } else found.append(el('p', 'insp-scope-ok', cleanText(c.detail, 240) || 'Every changed file is inside the scope.'));
    grid.append(allowed, found);
    sec.append(grid);
    return sec;
  }

  // ---------------------------------------------------------------- design

  function designSection(i: InspectionView): HTMLElement | null {
    const c = i.checks.find((x) => x.name === 'design');
    const d = i.design;
    if (!c && !d) return null;
    const sec = el('section', 'detail-sec insp-design');
    sec.append(secHead('Design', d ? `${d.before === null ? 'no score' : `${d.before}`} before, ${d.after} after, of 10` : ''));
    if (!d) {
      sec.append(el('p', 'detail-quiet', cleanText(c?.detail, 300)));
      return sec;
    }
    const scores = el('p', 'insp-design-said');
    scores.append(
      document.createTextNode(
        d.diffOnly
          ? `Judged on the diff alone: nothing to render. The repo has no screenshot script and nothing the city can preview, so the vision judge read the change as text and scored it ${d.after} of 10.`
          : `A vision judge scored the screens ${d.before === null ? 'after the change' : 'before and after the change'} against the design bar: ${d.before === null ? '' : `${d.before} before, `}${d.after} after. It passes at 6 or more, and no more than a point below where it was.`,
      ),
    );
    sec.append(scores);
    // The judge's own notes follow its scores in the check's detail.
    const notes = /of 10 \([^)]*\)\.\s*(.+)$/s.exec(cleanText(c?.detail, 600))?.[1];
    if (notes) sec.append(el('blockquote', 'insp-note', notes));
    if (!d.diffOnly) {
      if (!d.shots.length) sec.append(el('p', 'detail-quiet', 'No screenshots were kept.'));
      for (const s of d.shots) {
        const fig = el('figure', 'insp-shots');
        fig.dataset.route = s.route;
        const cap = el('figcaption', 'insp-route');
        cap.append(el('code', '', cleanText(s.route, 120)));
        fig.append(cap);
        const pair = el('div', 'insp-pair');
        for (const which of ['before', 'after'] as const) {
          const cell = el('div', `insp-shot ${which}`);
          cell.append(el('span', 'insp-shot-label', which === 'before' ? 'Before' : 'After'));
          const url = s[which];
          // Only the engine's own shot route, by the id and route it names.
          if (url && url === api.shotUrl(i.id, s.route, which)) {
            const a = el('a', 'insp-shot-link');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener';
            const img = el('img', 'insp-img');
            img.src = url;
            img.alt = `${s.route} ${which} the change`;
            img.loading = 'lazy';
            img.decoding = 'async';
            a.append(img);
            cell.append(a);
          } else cell.append(el('p', 'detail-quiet insp-noshot', 'No screenshot.'));
          pair.append(cell);
        }
        fig.append(pair);
        sec.append(fig);
      }
    }
    return sec;
  }

  function costSection(i: InspectionView): HTMLElement {
    const sec = el('section', 'detail-sec insp-cost');
    const p = el('p', 'detail-quiet');
    p.append(document.createTextNode(i.cost > 0 ? `The inspection cost ${money(Math.round(i.cost * 100) / 100)} credits, paid by the city. ` : 'No model was called for this inspection. '));
    p.append(pageLink('insp-run-link', 'The run', 'run', i.runId), document.createTextNode(' · '), pageLink('insp-job-link', 'The job', 'job', i.jobId));
    sec.append(p);
    return sec;
  }

  function render(): void {
    if (!sheet.shown || !insp) return;
    const i = insp;
    const j = job?.job ?? null;
    setTrail(sheet.trail, [
      ['Jobs', placeHref('jobs')],
      [`${shortName(i.repo)}${j?.issue != null ? ` #${j.issue}` : ''}`, placeHref('job', i.jobId)],
      ['Inspection', null],
    ]);
    const v = verdict(i);
    sheet.root.dataset.verdict = v.state;
    if (sheet.title.dataset.text !== v.text) {
      sheet.title.dataset.text = v.text;
      sheet.title.replaceChildren(el('i', `verdict-mark ${v.state}`), el('span', 'verdict-text', v.text));
      sheet.title.querySelector('i')!.setAttribute('aria-hidden', 'true');
    }
    const run = job?.runs.find((r) => r.id === i.runId);
    const when = new Date(i.at);
    const date = Number.isNaN(when.getTime()) ? '' : ` on ${when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    sheet.sub.textContent = `${cleanText(j?.title ?? '', 160) || 'The change'}${run ? `, the work of ${names.agent(run.agentId)} of ${names.firm(run.firmId)}` : ''}, inspected${date}.`;
    slots.checks(JSON.stringify([i.id, i.checks, [...openLogs]]), () => checksSection(i));
    slots.review(JSON.stringify([i.id, i.checks.find((c) => c.name === 'review'), i.reviewerAgentId, names.agent(i.reviewerAgentId ?? '')]), () => reviewSection(i));
    slots.scope(JSON.stringify([i.id, i.checks.find((c) => c.name === 'scope'), j?.scope]), () => scopeSection(i));
    slots.design(JSON.stringify([i.id, i.design, i.checks.find((c) => c.name === 'design')]), () => designSection(i));
    slots.cost(JSON.stringify([i.id, i.cost]), () => costSection(i));
  }

  return {
    show(next) {
      const changed = next !== id;
      id = next;
      if (changed) {
        insp = null;
        job = null;
        openLogs.clear();
        sheet.title.replaceChildren();
        sheet.title.dataset.text = '';
        sheet.sub.textContent = '';
        for (const s of Object.values(slots)) s('', () => null);
      }
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
      }
      if (changed) body.scrollTop = 0;
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
    },
  };
}

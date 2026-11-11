import type { Agent, AgentDetail, FirmView, Job, RunView } from '../../../shared/types';
import { api, type EngineEvent } from '../api';
import { placeHref } from '../router';
import { cleanText, money } from './board';
import { button, el, plural } from './controls';
import { issueBlocks } from './detail';
import { gauge, measures, silhouetteGlyph } from './firms';
import { ERA_NAMES, floorList, ROOT_NAMES, type MarketNames } from './inspector';
import { blockNodes, coalesce, detailSheet, keyedSlot, pageLink, secHead, setTrail } from './pages';
import { lineageWords, shortDate, workflowWords } from './story';
import './market.css';

export interface AgentPage {
  show(id: string): void;
  hide(): void;
}

export interface AgentPageOptions {
  listen(fn: (e: EngineEvent) => void): () => void;
  onDismiss(): void;
  /** Follow the agent through the city as it works (Task 34). */
  follow(agentId: string): void;
  /** Ride the lift up the agent's tower (Task 35). */
  rideUp(agentId: string): void;
}

const TOOL_WORDS: Record<string, string> = {
  read: 'read files',
  edit: 'edit files',
  write: 'write files',
  glob: 'find files by name',
  grep: 'search inside files',
  run: 'run commands in its sandbox',
};

const OUTCOME_WORDS: Record<string, string> = { merged: 'Merged', failed: 'Failed inspection', closed: 'Closed', killed: 'Stopped', capped: 'Stopped at its cap', crashed: 'Crashed' };
const RUNS_SHOWN = 12;

/**
 * An agent's own page (#/agents/:id): the persona in full, as its file has
 * it; its design as the genome fields read (model, tools, workflow shape,
 * memory); its lineage (where it came from, its parents and children as
 * links); its tower floor by floor, listed as the inspector lists a tower;
 * its runs; and the calibration of its firm, which every bid it makes is
 * trimmed by. Follow and Ride up open the city on it.
 */
export function createAgentPage(parent: HTMLElement, opts: AgentPageOptions): AgentPage {
  const sheet = detailSheet(parent, 'agentpage', opts.onDismiss);
  const body = sheet.body;
  const line = el('p', 'firm-motto-big agent-line');
  sheet.title.after(line);
  const trouble = el('p', 'detail-trouble');
  trouble.hidden = true;
  body.append(trouble);
  const slots = {
    head: keyedSlot(sheet.actions),
    // Its design and lineage read at a glance; the persona is the long read beneath them.
    design: keyedSlot(body),
    lineage: keyedSlot(body),
    persona: keyedSlot(body),
    tower: keyedSlot(body),
    runs: keyedSlot(body),
    calibration: keyedSlot(body),
  };

  let id: string | null = null;
  let detail: AgentDetail | null = null;
  let firms: FirmView[] = [];
  let jobs = new Map<string, Job>();
  let unlisten: (() => void) | null = null;
  let allRuns = false;

  const firmName = (x: string): string => cleanText(firms.find((f) => f.id === x)?.name ?? x, 80);

  const read = coalesce(async () => {
    const want = id;
    if (!want) return;
    try {
      const [d, fs, js] = await Promise.all([api.agent(want), api.firms(), api.jobs().catch(() => [...jobs.values()])]);
      if (want !== id) return;
      detail = d;
      firms = fs;
      jobs = new Map(js.map((j) => [j.id, j]));
      trouble.hidden = true;
    } catch (err) {
      if (want !== id) return;
      trouble.textContent = err instanceof Error && /unknown agent/.test(err.message) ? 'There is no such agent. It may belong to another city.' : `The engine did not answer. ${err instanceof Error ? err.message : String(err)}`;
      trouble.hidden = false;
    }
    render();
  });

  function onEvent(e: EngineEvent): void {
    if (!id) return;
    if (e.type === 'engine.reconnected') return read();
    const d = (e.data ?? {}) as Record<string, any>;
    const agentId = d.agentId ?? d.agent?.id ?? d.run?.agentId ?? d.bid?.agentId ?? d.site?.agentId ?? d.floor?.earned?.agentId ?? null;
    if (agentId === id || (detail && (d.firmId ?? d.run?.firmId) === detail.agent.firmId) || e.type === 'tower.sold' || e.type === 'merge.detected' || e.type === 'merge.reverted') read();
  }

  // ---------------------------------------------------------------- the head

  function headActions(a: Agent): HTMLElement {
    const wrap = el('div', 'detail-actions-wrap');
    const row = el('div', 'detail-actions-row');
    const follow = button('agent-follow', 'Follow', () => opts.follow(a.id));
    follow.dataset.follow = a.id;
    follow.setAttribute('aria-label', `Follow ${cleanText(a.name, 80)} through the city`);
    const ride = button('agent-ride', 'Ride up', () => opts.rideUp(a.id));
    ride.dataset.ride = a.id;
    ride.setAttribute('aria-label', `Ride up ${cleanText(a.name, 80)}’s tower`);
    // Until the city tour lands (Tasks 34 and 35) both are in place but say they are not ready.
    for (const b of [follow, ride]) {
      b.setAttribute('aria-disabled', 'true');
      b.title = 'Arrives with the city tour';
    }
    const jump = el('button', 'textbtn agent-jump', 'Read its persona');
    jump.type = 'button';
    jump.addEventListener('click', () => {
      const p = body.querySelector<HTMLElement>('.persona');
      p?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      p?.querySelector<HTMLElement>('.repos-sec')?.focus({ preventScroll: true });
    });
    row.append(follow, ride, jump);
    wrap.append(row);
    return wrap;
  }

  function subLine(d: AgentDetail): string {
    const a = d.agent;
    const firm = d.firm ? cleanText(d.firm.name, 80) : a.firmId;
    const role = a.lineage.origin === 'roster' ? `${cleanText(a.temperament, 60).replace(/^specialist/, 'Specialist')} at ${firm}` : `Of ${firm}, ${cleanText(a.temperament, 60)}`;
    const floors = d.tower ? d.tower.floors.filter((f) => f.earned?.state !== 'scar').length : 0;
    const where = d.tower ? `Its tower stands in ${d.towerFirmId && d.towerFirmId !== a.firmId ? `${firmName(d.towerFirmId)}’s root now` : 'the firm’s quarter'}, ${plural(floors, 'floor')} up.` : 'It has no tower standing.';
    const state = a.retired ? ` Retired: ${cleanText(a.retiredReason ?? '', 80)}.` : '';
    return `${role}. ${where}${state}`;
  }

  // ---------------------------------------------------------------- persona

  function personaSection(a: Agent): HTMLElement {
    const sec = el('section', 'detail-sec persona');
    const head = secHead('Persona');
    head.tabIndex = -1;
    sec.append(head);
    const prose = el('div', 'md persona-md');
    // The persona's own first heading is its name, already the page's title.
    const blocks = issueBlocks(a.instructions).filter((b, i) => !(i === 0 && b.kind === 'heading'));
    if (blocks.length) prose.append(...blockNodes(blocks));
    else prose.append(el('p', 'md-p quiet', 'Its persona file is empty.'));
    sec.append(prose);
    return sec;
  }

  // ---------------------------------------------------------------- design

  function designSection(d: AgentDetail): HTMLElement {
    const g = d.genome;
    const a = d.agent;
    const sec = el('section', 'detail-sec agent-design');
    sec.append(secHead('Design', 'as its genome reads'));
    const dl = el('dl', 'design');
    const row = (field: string, value: string | HTMLElement, gloss: string): void => {
      const r = el('div', 'design-row');
      r.dataset.field = field;
      const v = el('dd', 'design-val');
      if (typeof value === 'string') v.textContent = value;
      else v.append(value);
      r.append(el('dt', 'design-key', field), v, el('dd', 'design-gloss', gloss));
      dl.append(r);
    };
    row('model', cleanText(g.model, 80), g.note ? cleanText(g.note, 200) : a.model.startsWith('ollama:') ? 'A local model, run by Ollama on this Mac.' : 'A Claude model, run on your plan through Claude Code.');
    const tools = el('span', 'design-tools');
    for (const t of g.tools) tools.append(el('code', 'design-tool', cleanText(t, 40)));
    row('tools', tools, g.tools.length ? `It may ${g.tools.map((t) => TOOL_WORDS[t] ?? t).join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'No tools: it answers from what it is shown.');
    row('workflow.shape', g.workflow.shape, workflowWords(g.workflow.shape, g.workflow.n));
    if (g.workflow.shape === 'vote') row('workflow.n', String(g.workflow.n ?? 3), 'Plans written per bid.');
    row('memory.examples', String(g.memory.examples), g.memory.examples ? `Shown its firm’s ${plural(g.memory.examples, 'last merged job')} as worked examples when it bids.` : 'Shown no worked examples.');
    row('instructions', `${a.instructions.length.toLocaleString('en-GB')} characters`, 'The persona below, given to it word for word.');
    sec.append(dl);
    const market = el('p', 'design-market');
    market.textContent = `In the market it bids on ${a.bidsOn.join(', ')} tier jobs, takes at most ${a.maxTurns} turns on a job, and its model can build as high as the ${ERA_NAMES[a.capability]} era.`;
    sec.append(market);
    return sec;
  }

  // ---------------------------------------------------------------- lineage

  function kin(list: Agent[], none: string): HTMLElement {
    const p = el('span', 'lineage-kin');
    if (!list.length) {
      p.append(el('span', 'lineage-none', none));
      return p;
    }
    list.forEach((k, i) => {
      if (i) p.append(', ');
      p.append(pageLink('lineage-link', cleanText(k.name, 80), 'agent', k.id));
    });
    return p;
  }

  function lineageSection(d: AgentDetail): HTMLElement {
    const a = d.agent;
    const sec = el('section', 'detail-sec agent-lineage');
    sec.append(secHead('Lineage', `generation ${a.lineage.generation}`));
    sec.append(el('p', 'lineage-origin', lineageWords(a)));
    const chain = el('div', 'lineage-chain');
    const cell = (label: string, content: HTMLElement, self = false): HTMLElement => {
      const c = el('div', `lineage-cell${self ? ' self' : ''}`);
      c.append(el('span', 'lineage-label', label), content);
      return c;
    };
    chain.append(
      cell('Parents', kin(d.lineage.parents, a.lineage.origin === 'roster' ? 'none: written by hand for the roster' : 'none: the first of its line')),
      cell('This agent', el('span', 'lineage-self', cleanText(a.name, 80)), true),
      cell('Children', kin(d.lineage.children, 'none yet')),
    );
    sec.append(chain);
    return sec;
  }

  // ---------------------------------------------------------------- calibration

  function calibrationSection(d: AgentDetail): HTMLElement {
    const sec = el('section', 'detail-sec agent-calibration');
    const r = d.reputation;
    const firm = d.firm ? cleanText(d.firm.name, 80) : d.agent.firmId;
    sec.append(secHead('Its firm’s calibration', d.firm ? pageLink('cal-firm', firm, 'firm', d.firm.id) : firm));
    if (!r) {
      sec.append(el('p', 'detail-quiet', 'Its firm has no record.'));
      return sec;
    }
    const said = 0.8;
    const trimmed = Math.round(said * (1 - r.overclaim) * 100);
    sec.append(
      el(
        'p',
        'cal-said',
        r.samples
          ? `${firm} has had ${plural(r.samples, 'bid')} resolved. When ${d.agent.name.split(' ')[0]} says it is 80% sure, the city reckons ${trimmed}%${r.overclaim > 0 ? `: the firm has claimed ${Math.round(r.overclaim * 100)} points more than its record shows` : ', since the firm’s record bears out what it claims'}.`
          : `${firm} has no resolved bids yet, so every claim it makes is trimmed by ${Math.round(r.overclaim * 100)}% until its record says otherwise.`,
      ),
    );
    const ms = el('dl', 'standing-measures cal-measures');
    for (const m of measures(r)) {
      const row = el('div', `measure m-${m.key}`);
      const g = el('dd', 'measure-gauge');
      g.append(gauge(m.value, m.label, { width: 112 }));
      row.append(el('dt', 'measure-name', m.label), el('dd', 'measure-val', m.said), g);
      ms.append(row);
    }
    sec.append(ms);
    return sec;
  }

  // ---------------------------------------------------------------- tower

  function towerSection(d: AgentDetail): HTMLElement {
    const sec = el('section', 'detail-sec agent-tower');
    const t = d.tower;
    sec.append(secHead('Its tower', t ? plural(t.floors.length, 'floor') : 'none'));
    if (!t) {
      sec.append(el('p', 'detail-quiet', 'No tower stands for it: it retired before it built one.'));
      return sec;
    }
    const top = el('div', 'tower-top');
    top.append(silhouetteGlyph(d.agent.silhouette, { dark: !!t.dark }));
    const bought = d.towerFirmId && d.towerFirmId !== d.agent.firmId;
    top.append(
      el(
        'p',
        'tower-said',
        `${ROOT_NAMES[t.root]} root, ${d.agent.silhouette === 'plain' ? 'rising plain' : `a ${d.agent.silhouette} silhouette`}. ${bought ? `Bought by ${firmName(d.towerFirmId!)} when ${d.firm ? cleanText(d.firm.name, 80) : 'its firm'} went bankrupt, and re-clad in its root.` : t.dark ? 'Dark: its firm went bankrupt, and it waits for a buyer.' : 'It rises a floor for every job it merges.'}`,
      ),
    );
    sec.append(top);
    const names: MarketNames = {
      agents: new Map(firms.flatMap((f) => f.agents.map((a) => [a.id, a.name] as const))),
      firms: new Map(firms.map((f) => [f.id, f.name] as const)),
      inspections: new Map(d.runs.filter((r) => r.inspectionId).map((r) => [r.id, r.inspectionId!] as const)),
    };
    const { list } = floorList(t, { names, label: `Floors of ${cleanText(d.agent.name, 80)}’s tower, top to bottom`, linkAgents: false });
    sec.append(list);
    return sec;
  }

  // ---------------------------------------------------------------- runs

  function runRow(r: RunView): HTMLElement {
    const li = el('li', `agent-run ${r.outcome ?? 'live'}`);
    li.dataset.run = r.id;
    const j = jobs.get(r.jobId);
    const when = el('time', 'round-when', shortDate(r.startedAt));
    when.dateTime = r.startedAt;
    const what = el('div', 'round-what');
    what.append(pageLink('round-title', cleanText(j?.title ?? r.jobId, 140), 'run', r.id));
    const said = r.outcome ? (OUTCOME_WORDS[r.outcome] ?? r.outcome) : 'At work now';
    what.append(el('p', 'round-said', `${said}, on ${cleanText(r.repo.split('/')[1] ?? r.repo, 60)}. ${plural(r.progress.toolCalls, 'tool call')}, ${plural(r.progress.filesChanged, 'file')} changed.`));
    const cost = el('div', 'round-ev');
    cost.append(el('span', 'round-ev-ours', money(Math.round(r.progress.credits * 100) / 100)));
    cost.title = 'Credits the work cost its firm';
    const mark = el('i', 'round-mark');
    mark.setAttribute('aria-hidden', 'true');
    li.append(mark, when, what, cost);
    return li;
  }

  function runsSection(d: AgentDetail): HTMLElement {
    const sec = el('section', 'detail-sec agent-runs');
    const merged = d.runs.filter((r) => r.outcome === 'merged').length;
    sec.append(secHead('Runs', d.runs.length ? `${merged} of ${d.runs.length} merged` : ''));
    if (!d.runs.length) {
      sec.append(el('p', 'detail-quiet', 'No runs yet. It works once a bid of its wins a job.'));
      return sec;
    }
    const ol = el('ol', 'rounds agent-runs-list');
    const newest = [...d.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const r of allRuns ? newest : newest.slice(0, RUNS_SHOWN)) ol.append(runRow(r));
    sec.append(ol);
    if (!allRuns && newest.length > RUNS_SHOWN) {
      const more = el('button', 'textbtn rounds-more', `Show all ${newest.length}`);
      more.type = 'button';
      more.addEventListener('click', () => {
        allRuns = true;
        render();
      });
      sec.append(more);
    }
    return sec;
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    if (!sheet.shown || !detail) return;
    const d = detail;
    const a = d.agent;
    setTrail(sheet.trail, [
      ['Firms', placeHref('firms')],
      [d.firm ? cleanText(d.firm.name, 80) : a.firmId, placeHref('firm', a.firmId)],
      [cleanText(a.name, 80), null],
    ]);
    const title = cleanText(a.name, 80);
    if (sheet.title.textContent !== title) sheet.title.textContent = title;
    line.textContent = cleanText(a.persona, 240);
    sheet.root.dataset.retired = String(a.retired);
    sheet.sub.textContent = subLine(d);
    slots.head(a.id, () => headActions(a));
    slots.persona(JSON.stringify([a.id, a.instructions]), () => personaSection(a));
    slots.design(JSON.stringify([d.genome, a.bidsOn, a.maxTurns, a.capability]), () => designSection(d));
    slots.lineage(JSON.stringify([a.lineage, d.lineage.parents.map((x) => x.id), d.lineage.children.map((x) => x.id)]), () => lineageSection(d));
    slots.calibration(JSON.stringify([d.reputation, d.firm?.name]), () => calibrationSection(d));
    slots.tower(JSON.stringify([d.tower, d.towerFirmId, firms.length, d.runs.map((r) => r.inspectionId)]), () => towerSection(d));
    slots.runs(JSON.stringify([d.runs.map((r) => [r.id, r.outcome, r.stage, r.progress.credits]), jobs.size, allRuns]), () => runsSection(d));
  }

  return {
    show(next) {
      const changed = next !== id;
      id = next;
      if (changed) {
        detail = null;
        allRuns = false;
        sheet.title.textContent = '';
        sheet.sub.textContent = '';
        line.textContent = '';
        for (const s of Object.values(slots)) s('', () => null);
      }
      if (!sheet.shown) {
        sheet.show();
        unlisten = opts.listen(onEvent);
      }
      if (changed) sheet.body.scrollTop = 0;
      read();
    },
    hide() {
      sheet.hide();
      unlisten?.();
      unlisten = null;
    },
  };
}


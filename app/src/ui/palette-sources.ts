/**
 * The command palette's sources (Phase 5): small adapters over the same
 * live data the screens read, registered in one list. Each names its kind,
 * reads its entries from the API client, and says which events make it
 * stale. A repo connected, a firm founded, a job posted or a graduate made
 * appears with no change here; a new kind is one more adapter in SOURCES.
 */
import type { District, FirmView, Grant, Job, JobStatus, NetCard, Repo, VoyageView, Graduate, Brief } from '../../../shared/types.js';
import type { api as client, SchoolView } from '../api.js';
import type { Route } from '../router.js';
import { SCHOOL_SECTIONS, SCREENS } from '../router.js';
import { cleanText } from './board.js';
import { plural } from './controls.js';
import type { PaletteEntry } from './palette-rank.js';
import { fixed, KIND_LABEL, NET_LABEL, signed, STATUS_WORD } from './school-words.js';

/** The reads the sources make: the client's, so a test can stand in for the engine. */
export type PaletteApi = Pick<typeof client, 'repos' | 'city' | 'firms' | 'jobs' | 'school' | 'brief'>;

/** The ways there: the router, and the city's flights as main.ts hands them to the screens (handoffs.ts). */
export interface PaletteWays {
  navigate(route: Route, id?: string | null): void;
  /** Flies the city to a repo's tower; false when none stands yet. */
  flyToTower(repo: string): boolean;
  /** Flies the city to a firm's quarter; false when none stands yet. */
  flyToQuarter(firmId: string): boolean;
}

export interface PaletteSource {
  /** The kind every entry of this source carries, and the palette's tie-break order. */
  kind: string;
  /** The kind's word beside each row. */
  label: string;
  /** Whether an engine event of this type changes what this source would read. */
  stale(type: string): boolean;
  read(): Promise<PaletteEntry[]>;
  /** What the last read counted, for the empty state's line: pairs of a count and its singular. */
  tally?: Array<[number, string]>;
}

const startsWithAny = (prefixes: string[]) => (type: string): boolean => prefixes.some((p) => type.startsWith(p));
const shortRepo = (fullName: string): string => fullName.split('/').pop() ?? fullName;
const ownerOf = (fullName: string): string => fullName.split('/')[0] ?? '';
const shortModel = (model: string): string => model.split(':').slice(1).join(':') || model;
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const credits = (n: number): string => `${Math.round(n).toLocaleString('en-US')} credits`;

const JOB_STAGE: Record<JobStatus, string> = {
  proposed: 'proposed',
  open: 'open for bids',
  bidding: 'bidding',
  awarded: 'awarded',
  running: 'under way',
  inspecting: 'being inspected',
  shipping: 'shipping',
  waiting: 'waiting on you',
  merged: 'merged',
  failed: 'failed',
  closed: 'closed',
  halted: 'halted',
  withdrawn: 'withdrawn',
};

function repoState(r: Repo, d: District | undefined): string {
  const floors = d ? d.tower.floors.length : 0;
  const lit = d ? d.tower.floors.filter((f) => f.earned?.state === 'lit').length : 0;
  const stood = floors > 0 ? `${plural(floors, 'floor')}${lit > 0 ? `, ${lit} lit` : ''}` : '';
  if (r.halted) return stood ? `Halted, ${stood}` : 'Halted';
  if (r.status === 'error') return 'Analysis failed';
  if (r.status === 'analyzing' && !stood) return 'Being analysed';
  return stood || 'Not standing yet';
}

const GRANT_STATE: Record<Grant['state'], string> = {
  asked: 'Asked, waiting on you',
  granted: 'Granted',
  suspended: 'Suspended by the school',
  revoked: 'Revoked',
  declined: 'Declined',
};

function grantState(g: Grant): string {
  const head = GRANT_STATE[g.state] ?? cap(g.state);
  return g.state === 'granted' && g.acted > 0 ? `${head}, acted on ${g.acted === 1 ? 'once' : `${g.acted} times`}` : head;
}

const VOYAGE_STATE: Record<VoyageView['status'], string> = { sailing: 'Sailing', paused: 'Paused', done: 'Done', capped: 'Stopped at the cap', failed: 'Failed' };

function voyageState(v: VoyageView): string {
  if (v.queued) return 'Queued';
  const place = `generation ${v.generation} of ${v.of}`;
  return v.status === 'done' ? `${VOYAGE_STATE.done} after ${plural(v.generation, 'generation')}` : `${VOYAGE_STATE[v.status] ?? cap(v.status)}, ${place}`;
}

function netState(c: NetCard): string {
  if (c.status === 'trusted' && c.current) return `Trusted at v${c.current.version}, score ${fixed(c.current.score.value)}`;
  return cap(STATUS_WORD[c.status] ?? c.status);
}

/** The sources, in the order the palette breaks ties by kind. */
export function paletteSources(api: PaletteApi, ways: PaletteWays): PaletteSource[] {
  const screens: PaletteSource = {
    kind: 'screen',
    label: 'Page',
    stale: () => false,
    async read() {
      const pages: PaletteEntry[] = SCREENS.map((s) => ({ key: `screen:${s.route}`, kind: 'screen', name: s.name, state: '', go: () => ways.navigate(s.route) }));
      // The master is a net, read live by the nets' source; the other sections are pages of the school.
      for (const section of SCHOOL_SECTIONS) {
        if (section === 'master') continue;
        pages.push({ key: `screen:school/${section}`, kind: 'screen', name: cap(section), state: 'In the school', keys: ['school'], go: () => ways.navigate('school', section) });
      }
      return pages;
    },
  };

  const repos: PaletteSource = {
    kind: 'repo',
    label: 'District',
    stale: startsWithAny(['repo.', 'floor.', 'site.', 'merge.', 'engine.reconnected']),
    async read() {
      const [list, city] = await Promise.all([api.repos(), api.city().catch(() => [] as District[])]);
      const districts = new Map(city.map((d) => [d.repo, d]));
      const connected = list.filter((r) => r.connected);
      let floors = 0;
      const out = connected.map((r): PaletteEntry => {
        const d = districts.get(r.fullName);
        floors += d?.tower.floors.length ?? 0;
        return {
          key: `repo:${r.fullName}`,
          kind: 'repo',
          name: r.fullName,
          state: repoState(r, d),
          keys: [shortRepo(r.fullName), ownerOf(r.fullName)],
          go: () => {
            if (!ways.flyToTower(r.fullName)) ways.navigate('repo', r.fullName);
          },
        };
      });
      repos.tally = [[connected.length, 'district'], [floors, 'floor']];
      return out;
    },
  };

  const firms: PaletteSource = {
    kind: 'firm',
    label: 'Firm',
    stale: startsWithAny(['firm.', 'agent.', 'tower.', 'run.ended', 'engine.reconnected']),
    async read() {
      const list = await api.firms();
      firms.tally = [[list.length, 'firm']];
      return list.map((f): PaletteEntry => ({
        key: `firm:${f.id}`,
        kind: 'firm',
        name: f.name,
        state: f.status === 'bankrupt' ? 'Bankrupt' : `${credits(f.balance)}, ${plural(f.agents.filter((a) => !a.retired).length, 'agent')}`,
        keys: f.motto ? [f.motto] : [],
        go: () => {
          if (!ways.flyToQuarter(f.id)) ways.navigate('firm', f.id);
        },
      }));
    },
  };

  const agents: PaletteSource = {
    kind: 'agent',
    label: 'Agent',
    stale: startsWithAny(['agent.', 'firm.', 'tower.', 'graduate.', 'engine.reconnected']),
    async read() {
      const list: FirmView[] = await api.firms();
      const out: PaletteEntry[] = [];
      let working = 0;
      for (const f of list) {
        for (const a of f.agents) {
          if (!a.retired) working++;
          const model = shortModel(a.model);
          out.push({
            key: `agent:${a.id}`,
            kind: 'agent',
            name: a.name,
            state: a.retired ? `${f.name}, retired` : `${f.name}, ${model}`,
            keys: [f.name, model],
            go: () => ways.navigate('agent', a.id),
          });
        }
      }
      agents.tally = [[working, 'agent']];
      return out;
    },
  };

  const jobs: PaletteSource = {
    kind: 'job',
    label: 'Job',
    stale: startsWithAny(['job.', 'run.', 'bid.', 'inspection.', 'engine.reconnected']),
    async read() {
      const list: Job[] = await api.jobs();
      return list
        .filter((j) => j.status !== 'withdrawn')
        .map((j): PaletteEntry => ({
          key: `job:${j.id}`,
          kind: 'job',
          name: cleanText(j.title, 120) || `Job ${j.id}`,
          state: `${shortRepo(j.repo)}${j.issue ? ` #${j.issue}` : ''}, ${JOB_STAGE[j.status] ?? j.status}`,
          keys: [j.repo, shortRepo(j.repo), ...(j.issue ? [`#${j.issue}`] : [])],
          go: () => ways.navigate('job', j.id),
        }));
    },
  };

  /** The school is read once for its three kinds and the grants: one fetch, shared for a moment. */
  let schoolRead: { at: number; p: Promise<SchoolView> } | null = null;
  const school = (): Promise<SchoolView> => {
    const now = Date.now();
    if (!schoolRead || now - schoolRead.at > 500) {
      const p = api.school();
      schoolRead = { at: now, p };
      p.catch(() => {
        if (schoolRead?.p === p) schoolRead = null;
      });
    }
    return schoolRead.p;
  };
  const schoolStale = startsWithAny(['net.', 'train.', 'voyage.', 'graduate.', 'arena.', 'autonomy.', 'engine.reconnected']);

  const nets: PaletteSource = {
    kind: 'net',
    label: 'Net',
    stale: schoolStale,
    async read() {
      const s = await school();
      return s.nets.map((c): PaletteEntry => ({
        key: `net:${c.net}`,
        kind: 'net',
        name: NET_LABEL[c.net] ?? c.net,
        state: netState(c),
        keys: ['school', c.net],
        // The master has its own section; every other net its page.
        go: () => (c.net === 'master' ? ways.navigate('school', 'master') : ways.navigate('net', c.net)),
      }));
    },
  };

  const voyages: PaletteSource = {
    kind: 'voyage',
    label: 'Voyage',
    stale: schoolStale,
    async read() {
      const s = await school();
      return s.voyages.map((v): PaletteEntry => ({
        key: `voyage:${v.id}`,
        kind: 'voyage',
        name: `Voyage on ${shortRepo(v.repo ?? v.arena)}`,
        state: voyageState(v),
        keys: ['school', v.repo ?? v.arena],
        go: () => ways.navigate('voyage', v.id),
      }));
    },
  };

  const graduates: PaletteSource = {
    kind: 'graduate',
    label: 'Graduate',
    stale: schoolStale,
    async read() {
      const s = await school();
      return s.graduates.map((g: Graduate): PaletteEntry => ({
        key: `graduate:${g.id}`,
        kind: 'graduate',
        name: `Graduate ${shortModel(g.model)}`,
        state: `Beat its base by ${signed(g.vsBase.diff)}, ${plural(g.examples, 'verified change')}`,
        keys: ['school', g.base],
        go: () => ways.navigate('graduate', g.id),
      }));
    },
  };

  const grants: PaletteSource = {
    kind: 'grant',
    label: 'Grant',
    stale: schoolStale,
    async read() {
      const s = await school();
      // Only what stands or waits: a declined or revoked grant is history the district page keeps.
      return s.grants
        .filter((g) => g.state === 'granted' || g.state === 'asked' || g.state === 'suspended')
        .map((g): PaletteEntry => ({
          key: `grant:${g.kind}:${g.repo}`,
          kind: 'grant',
          name: `${KIND_LABEL[g.kind] ?? g.kind} on ${shortRepo(g.repo)}`,
          state: grantState(g),
          keys: [g.repo, 'autonomy'],
          go: () => ways.navigate('repo', g.repo),
        }));
    },
  };

  const brief: PaletteSource = {
    kind: 'brief',
    label: 'Brief',
    stale: startsWithAny(['brief.', 'job.changed', 'inspection.done', 'engine.reconnected']),
    async read() {
      const b: Brief = await api.brief();
      return b.sections.waiting.map((item): PaletteEntry => ({
        key: `brief:${item.id}`,
        kind: 'brief',
        name: cleanText(item.title, 120) || 'An item of the brief',
        state: 'Waiting in the brief',
        keys: item.repo ? [item.repo, shortRepo(item.repo)] : [],
        go: () => ways.navigate('brief'),
      }));
    },
  };

  return [screens, repos, firms, agents, jobs, nets, voyages, graduates, grants, brief];
}

/** Every source read at once; one that fails (the engine away, a route refused) leaves the others standing. */
export async function readAll(sources: PaletteSource[]): Promise<PaletteEntry[]> {
  const lists = await Promise.all(sources.map((s) => s.read().catch(() => [] as PaletteEntry[])));
  return lists.flat();
}

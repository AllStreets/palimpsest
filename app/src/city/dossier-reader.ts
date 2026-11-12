/**
 * Reads the floor dossiers (Phase 3 Task 18) in the background, so the ride
 * never waits for them: each picked floor's job detail (and, for a floor a
 * README proposal built, its audit's claim) through one pool of at most
 * three reads at a time, city-wide. A cancel (the ride ending, the
 * inspector closing, another tower) aborts what is in flight, drops what is
 * queued and anything that lands after it. A floor whose read failed is an
 * ordinary floor on the ride: it is never waited at empty.
 */
import { dossierFloors, dossierOf, type Dossier } from '../../../shared/ride.js';
import type { Floor, JobDetail, TowerSpec } from '../../../shared/types.js';

/** What the reader asks of the engine (api.ts). */
export interface DossierApi {
  jobs(): Promise<Array<{ id: string; source: string }>>;
  job(id: string, signal?: AbortSignal): Promise<JobDetail>;
  audit(id: string, signal?: AbortSignal): Promise<{ findings: Array<{ id: string; claim: string }> }>;
}

export interface DossierReader {
  /** Reads the tower's picked floors not read yet; resolves when they have landed (or failed, or been cancelled). */
  read(spec: TowerSpec): Promise<void>;
  /** A floor's dossier once read, else null. */
  get(floorId: string): Dossier | null;
  /** The ride's dossier floors now: each read one, and an empty one for each still on its way; a failed one is left out. */
  planFor(spec: TowerSpec): Map<string, Dossier>;
  /** The jobs a proposal built; `fresh` reads them again (each ride does), and a failed read is tried again next time. */
  proposals(fresh?: boolean): Promise<ReadonlySet<string>>;
  /** Stops every read in flight or queued; what lands after it is dropped. */
  cancel(): void;
  /** Sets a dossier by hand (captures). */
  put(floorId: string, d: Dossier): void;
}

/** At most this many reads at once, city-wide. */
export const DOSSIER_READS = 3;

const EMPTY: Dossier = { diff: null, plan: null, verdict: null, claim: null, firm: null };

export function createDossierReader(api: DossierApi, o: { firm(firmId: string): string | null; redact(s: string): string }): DossierReader {
  const read = new Map<string, Dossier>();
  const failed = new Set<string>();
  const pending = new Set<string>();
  const claims = new Map<string, Promise<Map<string, string>>>();
  let proposalSet: Promise<ReadonlySet<string>> | null = null;
  let known: ReadonlySet<string> = new Set();
  let epoch = 0;
  let controller = new AbortController();
  // The one pool: tasks wait their turn; at most DOSSIER_READS run.
  const queue: Array<() => Promise<void>> = [];
  let running = 0;
  const pump = (): void => {
    while (running < DOSSIER_READS && queue.length) {
      const task = queue.shift()!;
      running++;
      void task().finally(() => {
        running--;
        pump();
      });
    }
  };

  async function readOne(f: Floor, at: number, signal: AbortSignal): Promise<void> {
    const e = f.earned!;
    try {
      // A cancel since this was queued: it never starts.
      if (at !== epoch) return;
      const d = await api.job(e.jobId, signal);
      let claim: string | null = null;
      const prop = d.job.proposal;
      if (d.job.source === 'proposal' && prop) {
        let found = claims.get(prop.auditId);
        if (!found) {
          found = api.audit(prop.auditId, signal).then(
            (a) => new Map(a.findings.map((x) => [x.id, x.claim])),
            () => {
              claims.delete(prop.auditId);
              return new Map<string, string>();
            },
          );
          claims.set(prop.auditId, found);
        }
        claim = (await found).get(prop.findingId) ?? null;
      }
      // A cancel while it was reading: what it read is dropped.
      if (at !== epoch) return;
      const run = d.runs.find((r) => r.id === e.runId) ?? null;
      const inspection = d.inspections.find((i) => i.runId === e.runId) ?? null;
      const dossier = dossierOf(f, { job: d.job, bids: d.bids, award: d.award, run, inspection, claim, firm: o.firm(e.firmId), redact: o.redact });
      if (dossier) read.set(f.id, dossier);
      else failed.add(f.id);
    } catch {
      if (at === epoch) failed.add(f.id);
    } finally {
      pending.delete(f.id);
    }
  }

  const reader: DossierReader = {
    async proposals(fresh = false) {
      if (fresh || !proposalSet) {
        proposalSet = api.jobs().then(
          (js) => new Set(js.filter((j) => j.source === 'proposal').map((j) => j.id)),
          () => {
            // Tried again next time, rather than an empty set for the session.
            proposalSet = null;
            return new Set<string>();
          },
        );
      }
      known = await proposalSet;
      return known;
    },
    async read(spec) {
      await reader.proposals();
      const at = epoch;
      const signal = controller.signal;
      const floors = dossierFloors(spec.floors, known)
        .filter((id) => !read.has(id) && !pending.has(id) && !failed.has(id))
        .map((id) => spec.floors.find((f) => f.id === id))
        .filter((f): f is Floor => !!f?.earned);
      const done = floors.map(
        (f) =>
          new Promise<void>((resolve) => {
            pending.add(f.id);
            queue.push(() => readOne(f, at, signal).finally(resolve));
          }),
      );
      pump();
      await Promise.all(done);
    },
    get: (id) => read.get(id) ?? null,
    planFor(spec) {
      return new Map(dossierFloors(spec.floors, known).filter((id) => !failed.has(id)).map((id) => [id, read.get(id) ?? EMPTY]));
    },
    cancel() {
      epoch++;
      controller.abort();
      controller = new AbortController();
      // The queued reads never start; each still settles its promise.
      for (const task of queue.splice(0)) void task();
      pending.clear();
    },
    put(id, d) {
      read.set(id, d);
      failed.delete(id);
    },
  };
  return reader;
}

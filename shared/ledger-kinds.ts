/**
 * The closed list of ledger entry kinds. `record()` refuses anything else,
 * so replay (Task 18) can rely on knowing every kind it will meet.
 */
export const LEDGER_KINDS = [
  // Phase 1
  'repo.analyzed',
  'repo.connected',
  'repo.disconnected',
  'repo.error',
  'repo.patched',
  'usage.hook.installed',
  'engine.stopped',
  'engine.resumed',
  // Phase 2: the market
  'firm.seeded',
  'agent.seeded',
  'agent.hired',
  'agent.retired',
  'agent.revived',
  'job.proposed',
  'job.posted',
  'job.changed',
  'bid.placed',
  'job.awarded',
  'run.started',
  'run.stage',
  'run.refused',
  'run.diff',
  'run.ended',
  'check.done',
  'inspection.done',
  'pr.opened',
  'pushed',
  'merge.detected',
  'merge.reverted',
  'floor.laid',
  'floor.lit',
  'floor.removed',
  'floor.scarred',
  'credits.moved',
  'firm.bankrupt',
  'tower.sold',
  'repo.halted',
  'repo.resumed',
  'trip.started',
  'trip.ended',
  'report.written',
  'api.key.set',
  'api.key.removed',
  'run.note',
  // Phase 3: the audit, the brief and milestones
  'audit.started',
  'audit.stage',
  'audit.ended',
  'brief.opened',
  'brief.action',
  'milestone.reached',
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

const KNOWN: ReadonlySet<string> = new Set(LEDGER_KINDS);

export function isLedgerKind(kind: string): kind is LedgerKind {
  return KNOWN.has(kind);
}

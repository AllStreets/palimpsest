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
  // Nov 19: a seeded agent moved to another model (remodelAgents).
  'agent.remodelled',
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
  // Nov 19, economy change D: a firm at or below -150 benched (its clock paused), and off the bench again.
  'firm.benched',
  'firm.unbenched',
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
  // Phase 5 Task 32: a reached milestone's row patched (the spire passed on, a ribbon's or lights' end moved).
  'milestone.changed',
  // Phase 4: the school, its arenas, voyages and training, the nets, his decisions and earned autonomy
  'school.enabled',
  'arena.built',
  // Task 28 fix round 1: an arena build he asked for that the engine refused as it started, with the reason (no table).
  'arena.refused',
  'voyage.started',
  'voyage.commissioned',
  'voyage.generation',
  'voyage.ended',
  'train.started',
  'train.paused',
  'train.ended',
  'net.trained',
  'net.promoted',
  'master.predicted',
  'decision.resolved',
  'autonomy.asked',
  'autonomy.granted',
  'autonomy.declined',
  'autonomy.suspended',
  'autonomy.revoked',
  'autonomy.acted',
  'graduate.made',
  'merge.followup',
  // Nov 20: the budget opened up (its caps changed through Settings), so cooling jobs reopen at their next tick.
  'budget.opened',
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

const KNOWN: ReadonlySet<string> = new Set(LEDGER_KINDS);

export function isLedgerKind(kind: string): kind is LedgerKind {
  return KNOWN.has(kind);
}

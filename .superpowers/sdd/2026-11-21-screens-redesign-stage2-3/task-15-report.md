# Task 15 report: real figures from the engine

Status: DONE_WITH_CONCERNS (minor; see Concerns)

Commit: 26babdc "Brief items carry their figures as fields, not only in sentences" (on b897b2e).

## What changed

- `shared/types.ts`: new `BriefFigures` union; `BriefItem.figures: BriefFigures | null`; `Brief.counts: { waiting, merged, spent }`.
- `engine/brief.ts`: `Draft.figures`, set by `toItem` as `d.figures ?? null`. Each kind's figures come from the same value its sentence uses:
  - merged `{ paid }`: `chosen.price` or null.
  - failed `{ attemptsLeft, retry }`: `final ? 0 : MAX_ATTEMPTS - attempts`; `retry` is the job's `value` when Retry is offered, else null.
  - pr `{ pr }`: `r.prNumber`.
  - proposal `{ cost }`: `TIER_VALUE[j.tier]`, recomputed from the tier in force. `actOn(..., 'tier')` also sets it on the item it returns.
  - audit `{ real, partial, missing, stubbed, broken, claims, jobs }`. Stubbed is included. Null unless `status === 'done'`.
  - halt `{ resume }`: the summed `value` of the repo's halted jobs that Resume reopens for bids (`haltedFrom !== 'waiting'`, matching `resumeJob`). It may be 0.
  - audit-due `{ audit }`: `getSettings().auditMaxCredits`, the most an audit may spend.
  - usage `{ window, nowPct, capPct, mine }` as specified.
  - autonomy `{ agreed, of, here, hereOf }`. `agreed` and `of` are the sentence's pooled numbers. `here` and `hereOf` come from `agreement(kind, repo).repoAgreed / repoRows` in `engine/school/decisions.ts`. That is a real count of the repo's last decisions, up to 10, that have a non-null `agreed`, so it is not a constant.
  - tour `{ stops, seconds }`: `realStops(tour)`, `Math.round(tour.seconds)`.
  - revert `{ sha }`: `mergeSha.slice(0, 7)` or null.
  - note, milestone, stale, acted and graduate: null.
- `lead()` now takes the open count it used to compute. `briefData` computes `open` and `numbers()` once and uses them for both the lead and `counts`. The lead text is unchanged.
- `test/brief-words.test.ts`: its item fixture adds `figures: null`. This was a type fix only.

## Key sums for Task 16 (keySum)

| action | sum |
|---|---|
| accept | `proposal.cost` |
| retry | `failed.retry` |
| resume | `halt.resume` |
| audit | `audit-due.audit` |

## Rulings honoured

- Sentences are word for word: a new test pins the exact `text` (and the usage title and the lead) for merged, failed, pr, proposal, three audits (done, done with stubbed, failed), halt, revert, note, audit-due and usage. That test passed before the engine change and still passes after it. The autonomy and tour texts are pinned in their own tests.
- Autonomy: the planned `here === AGREE.repoLast` test is replaced. There are three asks:
  - 12 decisions with one against inside the last 10, one against outside them, plus one null: `here` 9, `hereOf` 10.
  - 4 decisions with 3 agreed: `here` 3, `hereOf` 4.
  - none: `here` 0, `hereOf` 0.
- No action behaviour, look or act call changed. `tools/fixtures/brief-actions.json` and `brief-act-calls.json` are untouched, and `test/brief-actions.test.ts` is green.
- Replay is unaffected: brief items are not in replay. `brief.opened` records ids only, `brief.action` records the same row as before, and replay.ts gives both no table.

## Tests

- New in `test/brief.test.ts` (7):
  - text word for word;
  - figures per kind, including the stubbed audit summing to its claims, the failed audit as null, and the usage `nowPct` matching its title;
  - counts against the lead;
  - proposal cost through two tier changes, including the item `actOn` returns;
  - his own limit, and the seven-day usage window;
  - the tour;
  - autonomy real counts;
  - kinds with no numbers as null.
- `npm run typecheck`: clean.
- `npm test`: 2401 tests, 2399 pass, 0 fail (2 were skipped by the suite's own skips).

## Concerns

1. Three key sums are my choices, because the spec names none:
   - halt `resume` counts only the jobs reopened for bids, so a halt whose only job is a waiting PR shows 0;
   - audit-due `audit` uses the cap (`auditMaxCredits`, default 40), not `AUDIT_ESTIMATE` (20, the lease estimate);
   - failed `retry` is the job's value, which is the bid ceiling and not a sure spend.

   Task 16 should hide a 0 resume sum. The controller may prefer the estimate for audit.
2. Two variants are added to the plan's union (`halt` and `audit-due`), and `failed` has the extra field `retry`, so the key sums live in figures as the ruling asks. Review Focus 1 lists halt as a kind without numbers. Its figures carry only the key sum, so Task 16 should not draw it as a readout.
3. An `acted` item that absorbed a merge keeps the payment in its text but has `figures: null`, as the spec says ("every other kind").
4. The new test file section uses the file's existing `// ------` divider style. That is a code comment, not screen words.

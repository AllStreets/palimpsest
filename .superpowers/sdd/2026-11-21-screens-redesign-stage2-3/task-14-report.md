# Task 14 report

Status: DONE_WITH_CONCERNS (concerns are minor, listed at the end).

Commit: 47c06e4 "Pin the Brief's action contract before the rebuild" (on 925721e). Not pushed.

## What was done

- `shared/brief-actions.ts`: `LOOKS = ['why', 'diff', 'fly', 'open-pr']`, the one exported constant. `engine/brief.ts` imports it and has no LOOKS of its own any more. `covers()` is unchanged.
- `app/src/ui/brief-actions.ts`: `type Effect`, and ONE table `ACTIONS: Record<BriefAction, { effect }>`. `EFFECT` is read from its rows, so it is not a second table. T16 should add `weight` and `label` as fields on these rows (ruling T16). It re-exports `LOOKS`.
- `app/src/ui/brief.ts`: `actionNode` reads `EFFECT[a]` for the open-pr link and the diff guard, and its switch is `switch (EFFECT[a])`. Main's `default: act(item, a)` is now `case 'act'`, and there is an unreachable `case 'open-pr': return` so the switch is exhaustive. Each action makes the same call as before.
- `tools/record-brief-actions.ts` reads origin/main through `git show` (shared/types.ts, app/src/ui/brief.ts, engine/brief.ts), never this branch's files. It parses actionNode's branches and default, the `look(item, '...')` calls and the engine's LOOKS. Its output is `tools/fixtures/brief-actions.json`, recorded once from 29187f0. The mapping matches the brief exactly.
- `test/brief-actions.test.ts` (4 tests) checks:
  - all 15 actions are present, and they match main's union;
  - EFFECT deep-equals the fixture's main mapping, and each ACTIONS row's effect equals EFFECT;
  - LOOKS equals main's engine LOOKS in order and the set of main's UI `look()` calls, and engine/brief.ts imports LOOKS from shared with no own copy;
  - brief.ts switches on `EFFECT[a]`, as a source check.
  
  The test failed before the code existed. A mutation (setting tour to act) fails it.
- `tools/ui-test-brief.ts` listens to `page.on('request')` for `POST /api/brief/items/:id/:action` on the main page, the second window and the tour page. It does two checks:
  - every click made exactly the call the script meant, with exact item ids and bodies, in order;
  - the run's calls equal `tools/fixtures/brief-act-calls.json`.
  
  It adds an Open PR step: a waiting PR row. window.open is stubbed for the click, so nothing leaves the machine, and restored afterwards. The fixture is written if it is missing, or with `BRIEF_ACT_CALLS=record`. Each run also writes its own copy to the shots folder.

## How the act-call fixture was recorded from main

The first ui-test ran on a build whose `app/src/ui/brief.ts` was byte-identical to origin/main, before the EFFECT switch. That run wrote the fixture:

why, accept, dismiss, tier {tier: low}, cap {pct: 60}, cap {pct: 50}, tour, open-pr, fly

Its items are proposal, proposal, failed, proposal, usage, usage, tour, pr and merged. I then rebuilt with the EFFECT dispatch and ran ui-test again. It reported "the act calls are main's contract (9 against 9)". Both full ui-test runs passed.

## Tests

- npm test: 2393 tests, 2391 pass, 0 fail (2 skipped).
- typecheck: clean.
- ui-test: passed twice, under the GPU lock. Both lock files were left as I found them (empty).

## Concerns

1. Item ids in the act-call fixture are normalised to the kind prefix plus `*` (for example `proposal:*`), because job, run and week ids are random per run. The exact ids are still checked within each run against the items the script targeted.
2. The fixture includes Fly, which the brief's list omits but the existing script does. Open PR is placed after the tour and before Fly.
3. The ruling that a tier change carries spend weight, and that retry, resume and audit keys carry their sum, belongs to T15/T16 (weights and keySum). Nothing here sets weights, so the table has no weight field yet.
4. The 'tier' body depends on the seeded proposal's tier (it was normal or high, so it went to low). If the sample economy changes that tier, the fixture needs re-recording from main.
5. The engine's old comment block keeps main's orphan line "The actions that finish an item..." with no declaration under it. It was already orphaned on main, and I left it alone.

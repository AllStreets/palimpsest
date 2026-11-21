# Task 16 report: the Brief's words, from fields

Status: DONE_WITH_CONCERNS (minor; see Concerns)

Commit: 0a5107c "The Brief's words read the engine's figures, cut hard" (on 908851b).

## What changed

- `app/src/ui/brief-actions.ts`: each `ACTIONS` row now has `effect`, `weight`, `label` and an optional `done` (the acted words). This is one table keyed by `BriefAction`, so there are no parallel tables:
  - `EFFECT` is still read from the rows.
  - `actionLabel`, `weightOf` and `actedLine` read the same rows.
  - Rows are built by `row()`. Any action in shared `LOOKS` gets the `look` weight from `LOOKS` itself and is not written out a second time. Any other action has to name its weight, or `row()` throws.
  - Tour is the one look weight that is not in `LOOKS`, so it names it.
  - A tier change has the `spend` weight, as the ruling says.
- `app/src/ui/brief-words.ts`:
  - `actionLabel`: the short labels from the table (Post, Tier, Dismiss, Why, Diff, Fly there, Retry, Resume, Open PR, Set limit, Audit, Walk the week, Let it act here, Not yet, Take back).
  - `weightOf(a)`:
    - grant is `grant`;
    - accept, tier, retry, resume, audit and cap are `spend`;
    - dismiss, decline and revoke are `decide`;
    - why, diff, fly, open-pr and tour are `look`.
  - `actedLine` uses the short forms: "Posted 09:14", "Tier low 09:14", "Limit 60% 09:14", "Limit set 09:14", "Not yet, quiet 30 days 09:14", "Taken back 09:14", "Walked 09:14", and so on. A look leaves no line.
  - `sinceLine` has four cases: "Since 06:40", "Since yesterday 06:40", "Since 12 Nov 06:40" (2 to 6 days back also uses the date), and an empty string when there is no time. A later window adds ", second look".
  - `briefMeta(item, now)` returns `{ where, when }` and replaces `dateline`. A temporary `dateline` built on `briefMeta` stays until Task 17 removes the import from brief.ts, as the commit message says.
  - `itemReadouts(item, names)` reads only `item.figures` and `item.refs`, through `names.firm` for the firm, and never reads `text`:
    - merged: merged ok, then the paid sum in cr, then the firm (quiet). When `paid` is null it shows "merged" with no sum.
    - pr: `#N` PR, the firm, then review warn.
    - failed: failed fail, then "N attempt(s) left", or "no attempts left" (quiet).
    - halt: halted fail only. The resume sum is never a readout.
    - revert: reverted fail, plus its short sha (key "commit").
    - proposal: the tier. The cost goes on the key.
    - audit: N jobs proposed.
    - audit-due: never audited warn. The audit sum goes on the key.
    - usage: now% with its window, then cap% (or "your limit" when it is his).
    - autonomy: agreed/of, then here/hereOf, which is skipped when hereOf is 0.
    - tour: stops and minutes.
    - note, stale, milestone, graduate and acted: `[]`.
    - Every number goes through a finite check, and empty values are filtered out.
  - `keySum(item, a)` returns "N cr" for:
    - accept, from `proposal.cost`;
    - retry, from `failed.retry`;
    - audit, from `audit-due.audit`;
    - resume, from `halt.resume`.

    It returns null when:
    - the action is not in `item.actions`;
    - the figures are missing;
    - the sum is null, not finite or 0.
  - `keyAria(item, a, head)` gives "Post, up to 60 credits: <head>", or "<label>: <head>" when there is no sum. Task 17 needs this, so I added it although the brief's interface list does not name it.
  - `headFigures(b)` reads `b.counts`:
    - waiting, zero-padded, with tone `hot` when it is above 0;
    - merged, zero-padded;
    - credits spent, through `creditsText`.
  - `toneOf(kind)`:
    - merged is ok;
    - failed, halt and revert are fail;
    - pr, audit-due, usage and stale are warn;
    - proposal is `ask`, and autonomy is `grant`;
    - everything else is `quiet`.
  - `streamWords(b, names)` takes each item's short repo name followed by its readout values, in section order, keeps only entries with a word character, and stops at 24.
  - `MOVE_LABEL` keeps the long words for Settings and the district page as literals, because `LABELS` no longer exists. Its values are unchanged.
  - `itemSentence`, `usageLine`, `grantState`, `grantMoves`, `waitingGroups` and the rest are unchanged.
  - The prototype's regex parsers (`leadFigures`, `auditCounts`, `agreementOf`) are not ported.
- `test/brief-words.test.ts`:
  - The old long-label, acted and since tests are replaced by the new ones: the labels (including that each label and weight comes from the `ACTIONS` row), weights (including every `LOOKS` action weighing `look`), the acted lines, `sinceLine` with all four cases and the second look, `briefMeta`, readouts from fields (including merged with null `paid`), no empty readouts (all 16 kinds with null figures, and the five named kinds giving `[]` or one state), the text never parsed, money on the key (all four sums, 0 hidden, not offered hidden, the aria-label), `headFigures`, `toneOf`, `streamWords`, and the voice check.
  - The dateline assertions became `briefMeta` assertions.

## Rulings honoured

- One table: `weightOf`, `EFFECT`, `actionLabel` and the acted words are all fields of `ACTIONS`.
- A tier change is spend.
- `LOOKS` decides the look weight in the table.
- Key sums are maxima ("N cr", with "up to N credits" in the aria-label). A sum of 0 shows nothing, a sum shows only while its action is offered, and halt's sum is never a readout.
- No action changed meaning. The `EFFECT` values are untouched, and `test/brief-actions.test.ts` (the Task 14 fixtures) is green.
- Voice: none of the labels, acted lines or since lines has an em dash, "--" or an emoji. A test checks this.

## Tests

- `node --no-warnings --import tsx --test test/brief-words.test.ts`: it failed first because the exports were missing, and now passes 27/27.
- `npm run typecheck`: clean.
- `npm test`: 2410 tests, 2408 pass, 0 fail, 2 skipped by the suite's own skips.

## Concerns

1. ui-test is expected to be red until Task 17, because brief.ts still sets the new short labels through its old markup and the Brief UI test expects the long words. The ruling allows this. brief.ts itself is not changed.
2. Choices the brief left open:
   - Resume carries its key sum, following the ruling "retry, resume and audit keys carry their sum", although the dispatch's list named only accept, retry and audit.
   - Usage's cap key reads "your limit" when `mine` is true.
   - A revert shows its sha.
   - A tour shows its stops and minutes.
   - `sinceLine` gives dates for 2 to 6 days back, with no weekday, as "older".
3. `keyAria` is an addition to the planned interface. It keeps the aria wording beside `keySum`, so Task 17 cannot drift from it.

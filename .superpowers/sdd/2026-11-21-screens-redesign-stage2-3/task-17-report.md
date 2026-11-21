# Task 17 report: the Brief on the shared layer

Status: DONE_WITH_CONCERNS (all gates pass; the concerns are presentation choices for review).

## Commits

- 697bb3e The Brief rebuilt on the screens layer (code, brief.css, tests, ui-test words, harness, WebP stills, critique and frames)
- the follow-up: the Task 10 gallery pin checks count only pins standing (the Brief keeps its own pins in the page, hidden), and this report

## What was built

- `app/src/ui/brief.ts`: the rendering rebuilt on the os layer. `act`, `look`, `toggleWhy`, `fly`, `tour`, `whyFor`, `capField`, the tier picker, the focus handling (`fill`, `focusNext`) and `prime` are as they were; `toggleWhy` only passes the arrived node through `reveal`.
  - The panel: `dressPanel(sheet)`; the sheet is still shown through `sheet.show()` (dressPanel wraps it), so the scan runs on the head once per open. The stream is filled with `panel.setStream(streamWords(b, names))`, never `createStream`.
  - The head: the day as `h1`, nothing over it; the since line (`sinceLine`) in ice, typed in once per open, in `.os-type-hold` with an `.os-type-ghost` copy, the typed span `aria-hidden` and the whole text in an `.os-sr` sibling; `headFigures` through `figure()` (waiting hot above 0); two `rangefinder`s (five-hour against today's limit, seven-day against its cap) inside one link to the treasury, whose aria-label is the usage sentence.
  - The lead and the usage sentence are `.brief-lead.os-sr` and `.brief-usage.os-sr`. The audit's explanation under Recommended is now `.os-sr` too (round 1, weakness 5).
  - Sections: `h2.brief-sec-head` with its name and a count; the list is labelled by it.
  - Rows: the designator (the pin number for an open waiting item with a repo, else a hairline), `briefMeta` (where, when), `h3.brief-head`, the sentence (`itemSentence`) as `.brief-sentence.os-sr`, the claims bar (`segmentBar`) on a finished audit, the two `agreementScales` on the ask (its readouts are left out there, since the scales say the same counts), then `.brief-line` with `readoutRow(itemReadouts(...))` (null skipped, so no empty box), the keys, and the acted line. Tier picker, cap field, Why, quiet line and error stay where they were in the row.
  - Keys: built as plain `button.brief-act` / `a.brief-act` (no `.textbtn`, so no underline can leak; the ui-test checks computed `text-decoration-line: none` on every key), the label in `.brief-act-label`, then `weighKey(node, weightOf(a), keySum(item, a) ?? undefined)`. The aria-label is `keyAria(item, a, head)` (", on GitHub" added for Open PR). The cap field's Set and Cancel are weighed spend and look.
  - Key order is lightest to heaviest, and of two keys of one weight the one with a sum stands last, so every row ends on its heaviest key (Post 60 cr, Resume 20 cr, Audit 40 cr, Let it act here). Presentation only: each key's action, call and focus selector are unchanged.
  - The autonomy ask (an open `grant`) is listed first among the open waiting rows; everything else keeps the engine's order. Presentation only; `brief.opened` still records the engine's ids.
  - Why: each plain `p.brief-why-text` types in (same hold, ghost and `.os-sr` pattern); a run summary (`summaryNodes`) is never typed: it gets `.brief-sweep` (opacity and an 8 px slide) and one `scanOnce` across it.
  - Pins: `createPins(parent, sheet.root, sheet.body, opts.city)`. Targets are the open waiting items with a repo, numbered in list order; the figure is the first readout's `v` plus its `k`; the tone is `toneOf`. The active item follows hover, then focus, then the autonomy ask, then the first target; its row gets `.is-active`. `show()`/`hide()` call the pins' `show()`/`hide()`. `setTargets` is called only when the targets change.
- `BriefOptions.city?: OsCity`; `main.ts` passes its one `osCity`.
- `brief-words.ts`: the temporary `dateline` is removed.
- `app/src/ui/brief.css` (new): the Brief's layout only, every colour from `--os-*` (black for shadows), only the two faces. `market.css` loses every Brief rule (the treasury's `.meter-today` stays). `screens.css` had no Brief rules left.
- Tests: `test/os-css.test.ts` now lints `brief.css` with the os sheets (backdrop-filter, transform/opacity-only motion, reduced-motion answers) and adds: colours from tokens only, no old faces, red only on the autonomy ask. `test/brief-source.test.ts` holds setStream, sheet.show, the weighed keys with keySum and keyAria, the pins wiring, the summary sweep, and the dateline's removal.
- ui-test: `tools/ui-test-brief.ts` updated to the new words (`/^Posted \d{2}:\d{2}$/`, `Dismissed`, `Tier low hh:mm`, `Limit 60% hh:mm`, ", second look", "Walk the week" and the tour's readouts); "never a row of buttons" replaced by: every key has `data-weight`, exactly one grant filled red per open ask, no underline on any key, Post's sum on the key and in its name; new checks: no row shows undefined, NaN or an empty readout box; pins on, plates at 0, the lock on the ask; designators numbered in list order; five opens and closes of the Brief in two seconds leave no hook, no pin and the plates whole. `tools/ui-test-school.ts`: the grant's new label and acted word, and `keyFocus` accepts the os focus ring (`.os-focus` `::after`) as well as an outline. `tools/ui-test.ts`: a `UI_ONLY=brief` mode (the Brief's checks and the autonomy checks) for the rounds.
- Harness: `tools/redesign-brief.ts` gains `brief-closed` (ported from the prototype) and `brief-why-long`, with `LONG_TITLE` (240 characters with `<b>` and `&amp;`) and `LONG_SUMMARY` (600 characters of markdown) seeded into the run's scratch home.

## Gates

- `npm test`: 2417 pass, 0 fail, 2 skipped. `npm run typecheck`: clean.
- Brief-only ui-test (`UI_ONLY=brief`) on the old screen (step 1): 14 failures, on the words and the new checks, as expected.
- Brief-only ui-test on the new screen: all pass except one race in my own check (it read the since line's textContent while it was still typing); fixed to read its `.os-sr` text. The act calls match main's fixture, 9 against 9.
- Full ui-test, run 1: two failures, both in Task 10's gallery pins checks, which counted every `.os-pin` in the page; the Brief now keeps its own pins in the page, hidden while it is closed. Those two checks now count pins standing (`.os-pins:not([hidden]) .os-pin`), which is what Review Focus 3 asks. Every other check passed, the Brief's included.
- Full ui-test, run 2: "ui-test passed".
- Frames (uncapped, 1512 x 890 at 2x, main 29187f0 in a detached worktree, two sittings):

| Tier | View | Main 1 | Branch 1 | Branch 2 | Main 2 |
| --- | --- | --- | --- | --- | --- |
| high | city alone | 8.60 | 11.50 | 8.60 | 8.60 |
| high | Brief open | 8.10 | 9.90 | 7.80 | 7.80 |
| medium | city alone | 4.90 | 5.70 | 4.80 | 4.80 |
| medium | Brief open | 4.50 | 4.90 | 4.40 | 4.50 |

  Sitting 1's branch run was slow on every view, the city alone included, while Spotlight was indexing (fseventsd and mds_stores at 100% CPU). Re-run at once in the opposite order, the branch equals main: Brief open 0% on high and -2% on medium; city alone 0% on both. Both sittings are in critique.md.
- GPU lock: taken for every capture, ui-test and perf run, the line written to both lock files and only that line removed; both files were empty before and after.

## Stills

`docs/superpowers/plans/redesign-stage2-3/stills/task-17/`: brief, brief-scrolled, brief-autonomy, brief-overview, brief-closed, brief-1280, brief-reduced-motion, brief-why-long (round 4, final), plus brief-round1, brief-1280-round2, brief-scrolled-round3. Four rounds in critique.md under "Task 17".

## Rulings applied

- setStream, not createStream; dressPanel called through sheet.show; the scan on the head only; the panel's 36 px foot untouched.
- Summaries swept, never typed. Typed text aria-hidden with an `.os-sr` sibling, in `.os-type-hold` with a ghost.
- keyAria on every key; no `.textbtn` on keys (checked live).
- Key sums from keySum (maxima, only while the action is offered, none for 0, never a readout for halt).
- readoutRow null skipped.
- Pins from pins.ts with the lock on the ask; shared pins show the lowest number and "+k" (pins.ts); null frames skipped (pins.ts).
- pins.ts never disconnects its ResizeObserver and scroll listener. Not torn down: the Brief is created once in main.ts and lives for the app's life, so there is nothing to tear down; while hidden both only set a dirty flag. Noted in brief.ts at the createPins call.
- No innerHTML in brief.ts (the existing lint covers it).

## Concerns

1. Two presentation changes beyond the plan's words: the open autonomy ask is listed first under Waiting on you, and keys stand lightest to heaviest. Neither changes an action, a call or the act-call sequence, but the tab order within a row and the ask's place in the list differ from main.
2. The pin figure for a proposal is the first readout ("normal tier"), as the plan says; C showed the cost. One line in `pinTargets` if Connor prefers the cost.
3. Tier is a spend key by ruling, so proposals show two lit keys (Tier, Post).
4. The first perf sitting's branch run was noisy (Spotlight); the second sitting is clean. A reviewer may want a third.
5. The audit explanation under Recommended is now for screen readers only.
6. tools/ui-test-screens.ts was changed (the two Task 10 pin counts), outside the files the brief named; it is under tools/*, which the ruling allows.

## Fix round 1 (controller review)

Important findings:
1. **Proposal pin figure.** `pinTargets` gives a proposal the cost: `keySum(item, 'accept')` while Post is offered, else `creditsText(figures.cost) cr`. Other kinds keep their first readout. ui-test: hovering the first open proposal puts the lock on its tower, and the lock tag's figure equals the Post key's sum ("60 cr against 60 cr"). My first version of this check read the first pin of each district and found none in the full run, where earlier checks move the proposals; it now goes through the lock.
2. **Red only on the open ask.** `row()` sets `is-ask` (kind autonomy with `grant` offered), and every red rule in brief.css (brackets, wash, acquire, designator, head size, line) is keyed on `.brief-item.is-ask`. The os-css test "red on the Brief is the autonomy ask's alone" now requires `is-ask` (or the grant tag). ui-test-school: once granted, the row has no `is-ask`, its `::before` is `none`, and there is no red in its background.
3. **Today's limit focus.** The input no longer takes `.os-focus`. `.sheet.brief .brief-cap-input:focus-visible` draws a 1.5 px amber outline 3 px out. ui-test: the focused field's computed outline is not `none` and is at least 1 px.

Minors:
- `reveal()` keeps each typedLine stop in `typing`, and `hide()` finishes them all.
- `hide()` calls `pins.setActive(null, null)`.
- The usage link's aria-label ends "Over the limit." when either window is at or past its cap.
- ui-test: the long-title row's `h3` contains the literal `<b>` and `&amp;`, and the row has no `<b>` element. The constants moved to ui-test-brief.ts; redesign-brief.ts imports them. The ui-test seeds the title into the first waiting PR's job before the page loads.
- Each row carries `data-repo`.

Gates:
- `npm test`: 2417 pass, 0 fail, 2 skipped. Typecheck clean.
- Brief-only ui-test: no failures.
- Full ui-test, run 3: 2 failures.
  - My first pin check, since rewritten.
  - `lod-400 frames differ by under 2% in mean luminance` (2.80%): a city tram check with the Brief closed. It passed in run 2 and is the flaky tram check noted at Task 8.
- Full ui-test, run 4: "ui-test passed" (the rewritten pin check: "60 cr against 60 cr").

Frames (uncapped, ms, high / medium):

| Sitting | Build | City alone | Brief open |
| --- | --- | --- | --- |
| 3 | main | 8.60 / 4.90 | 8.00 / 4.60 |
| 3 | branch | 9.10 / 5.50 | 9.80 / 5.10 |
| 4 | branch | 8.70 / 4.80 | 7.90 / 4.60 |
| 4 | main | 9.00 / 4.70 | 8.10 / 4.60 |
| 4 | branch | 9.40 / 5.00 | 8.60 / 4.70 |

- The machine slows through a sitting: Spotlight was indexing, with fseventsd and mds_stores at 100% CPU. Whichever build runs later is slower, and the city alone slows with it, though the Brief is closed there and draws nothing.
- Sitting 4 ran the branch both before and after main:
  - Branch before main: Brief open -2% on high and 0% on medium.
  - Branch after main: +6% and +2%, with the city alone +4% and +6% by the same drift.
- Sitting 3, with main first, shows the same drift, larger: the branch Brief open reads +22%, and the city alone moves +6% and +12%.
- Recorded in critique.md.

Stills: the seven that show pins were re-shot (all but brief-closed), and the proposal pins now read "60 cr".

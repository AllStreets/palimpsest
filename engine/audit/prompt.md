You are checking the repository {{repo}} for me. The README and the docs make promises; I want to know which of them the code keeps. Read as a careful engineer would, and say only what you can point at.

The repository is checked out in your working directory. You cannot change files; if a command would, do not run it. Use the read tools to look at the code, and the run tool to run the repository's own checks where they exist. Never install anything, never write, never fetch.

{{checks}}

Do this:

1. List every claim the README and the docs make that could be true or false of the code: a feature, a command, a supported platform, a guarantee. Skip taglines and opinions. Count them; that is `claims`.
2. Check each claim against the code: does the thing exist, is it wired to an entry point, is it exercised by a test, is it a stub or a hardcoded value. Run the checks when they bear on a claim.
3. Mark each claim with one of five verdicts:
   REAL: the code exists, is wired, and a test you found or ran exercises it.
   PARTIAL: it exists and is wired, but a named part of the claim is absent or untested.
   MISSING: nothing in the code does it.
   STUBBED: a function or path exists but returns a fixed or placeholder value, or nothing reaches it.
   BROKEN: it is wired, but a test fails, a type error stops it, or your own run of it fails.
4. Cite evidence as a file and a line in the repository, with a short note on what is there. Every finding needs at least one. A REAL verdict needs a line in a test file or a passing run of a check. Set `tested` to true only when a test covers the claim or you ran it.
5. For a MISSING, STUBBED or BROKEN claim, and for a PARTIAL one whose missing part you can name, propose one job a contractor could bid on: a title, a body with the claim, the evidence and what to build, the paths they may change as `scope` globs, at least one acceptance line, and a tier (`low`, `normal` or `high`). A REAL claim gets `proposal: null`.

Cite paths relative to the repository root. Never cite a path outside it, under `.git`, or a file you did not find in the checkout.

Here is the register I want, from an audit of another repository:

```
Real and tested: race engine, sealed sets, bootstrap CIs, re-grade, designer, and the fixtest coding arena pattern (clone, edit, run the suite).
Broken or missing: breeding outside geotag (a hardcoded tool allow-list in src/genome.ts rejects coding tools), no parent-versus-child significance test, geotag-specific self-check prompt, no sandbox, fossils are an MLP over embeddings for geotag only, no LoRA anywhere.
```

Answer only with JSON in the shape you were given: `claims` and `findings`, each finding with `claim`, `source` (the README or docs file and line the claim sits on), `verdict`, `tested`, `evidence` and `proposal`. No prose around it.

{{text}}

# Self-recursion guardrails

How the market is kept from feeding itself, and how an agent is kept from pushing, reaching his credentials or changing anything outside its run. Code locations are given as files and names; a part a later task builds is named by its task.

## The trigger graph

Every arrow is the only way its target comes to exist.

```
issue labelled palimpsest[:low|:high] by a person
  > job (open)                         engine/market/jobs.ts pollJobs
  > bid                                Task 12
  > award                              Task 12
  > run                                Task 13
  > PR (or push in push mode)          Task 16
  > GitHub

his direct request (job board)         engine/market/jobs.ts postManualJob
  > job (open) > bid > ... as above

analysis finds no test or build command
  > proposed harness job               engine/market/jobs.ts proposeHarnessJob
  > his click (accept)                 engine/market/jobs.ts acceptProposed
  > job (open) > bid > ... as above

PR poll sees a merge                   Task 16
  > floor laid on the job site and the agent's tower

revert watch sees a city merge reverted   Task 16
  > the repo halts until he clears it
```

## Why there is no cycle

The only writes the city makes to GitHub are branches named `palimpsest/*`, pull requests, labels (`palimpsest:done`, `palimpsest:failed`) and comments, all made by the engine from its own clone (ruling 20), never by an agent. None of them is a job source:

- Jobs come only from issues carrying a tier label. `pollJobs` skips any issue whose body carries `CITY_MARKER` (`[palimpsest]`, which every city comment and PR body carries) and any issue already labelled `palimpsest:done` or `palimpsest:failed` (`engine/market/jobs.ts`, `pollJobs`). A PR is not an issue in `gh issue list`.
- A reopened issue that once held a job stays off the board (`held` in `pollJobs`).
- City merges are excluded from founding history by the `Palimpsest-Job:` trailer and the `palimpsest/` head branch (`engine/history.ts`, `JOB_TRAILER`, `CITY_BRANCH`, `foundingFloors`), so a re-analysis never turns city work into history.
- The harness job is proposed, never posted: it does not bid until he accepts it (`proposeHarnessJob`, `acceptProposed`, `LEGAL_MOVES` in `shared/market-rules.ts`).
- Proposals that agents make arrive in Phase 3 and will pass the same marker and label filter before they can become jobs.

## Three layers that stop an agent pushing

Each is enough on its own for a push; together they also cover his credentials and his machine.

1. **No credentials.** Agent processes run with an environment built from nothing (`engine/market/sandbox.ts`, `childEnv`; `engine/exec.ts`, `clearEnv` and `NEVER_INHERITED`): a fake per-run `HOME`, an empty `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, no `GH_TOKEN`, `GITHUB_TOKEN` or API keys. The run clone's push URL is `no-push://palimpsest` (`engine/market/worktree.ts`, `PUSH_URL`, `createRunDir`). The engine pushes from its own clone, never from the run dir (ruling 20, Task 16).
2. **The guard.** `engine/market/guard-core.mjs`, `forbidden()` and `pathAllowed()`, typed in `engine/market/guard.ts`:
   - every command an agent runs goes through `execTool()` (`engine/market/broker.ts`), which refuses with `forbidden()` and records `run.refused` before anything runs;
   - claude's own file tools are checked by the PreToolUse hook (`engine/market/guard-hook.mjs`), which fails closed (exit 2 on any error, odd input or its 5 s timeout) and refuses every tool but `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep` and `mcp__palimpsest__run`;
   - the Ollama and API loops' file tools run in `engine/market/file-tool.mjs` through `execFileTool()`, which checks `pathAllowed()` and opens every file with `O_NOFOLLOW`.
   - The claude CLI has no shell tool; its only command tool is `mcp__palimpsest__run` (`engine/market/broker-mcp.mjs`), which forwards to the broker with a per-run bearer token read from `<ctl>/broker.token` and never passed on an argv (ruling 19).
3. **The sandbox.** `engine/market/sandbox.ts`, `toolProfile()` and `cliProfile()`, applied by `wrap()`: deny by default; his home unreadable except the run root and toolchains; writes only inside the run root, with every clone's `.git` and the clone directories themselves write-denied; exec of `gh`, `security`, `osascript`, `sudo`, `launchctl` and `open` denied; the keychain's mach services denied; outbound only to loopback (the engine port, Ollama and other runs' proxy and broker ports denied) and through the run's egress proxy (`engine/market/egress.ts`), which never lists GitHub.

`<ctl>/broker.token` is readable by both profiles (ctl is read-only to both), so a tool child can read it; but the broker's port is reachable only from the CLI profile's own network rule and from tool children of the same run, which already run every command through that same broker and guard. Another run's tool children are denied the port by their profile (it is registered with `registerRunPorts`) and hold a different token.

After every broker command and file tool call, `reapRun()` (`engine/market/reaper.ts`) kills whatever the call left running (a forked, setsid daemon): every process of his user that runs under this run's own sandbox profile (asked of the kernel with `sandbox_check` through a small helper each engine process compiles afresh with the system `cc`, `engine/market/sandbox-check.ts`: the profile allows reading `<runRoot>/ctl`, denies writing there and denies reading the runs directory, probes that no sandboxed process can rename or replace; a process cannot drop its sandbox). Only when that helper cannot be built does it fall back to the environment markers, an executable under the run root or a working directory there without a terminal. It spares the engine, its ancestors, its own unsandboxed descendants (its git, whose HOME is outside the agent's fake home), protected pids (the claude CLI) and live commands of the run, and signalling only pids verified still to belong to the run. `runQuiet()` is required before `diffOf`, `commitAll` and each claude tool turn (Tasks 9 and 13). The claude CLI also runs with `--disallowedTools` and `permissions.deny` from `CLI_DISALLOWED_TOOLS` and `CLI_PERMISSIONS_DENY` (`engine/market/guard.ts`, Task 9), so a hook that fails to start still leaves no shell.

**Proof that the hook ran.** The hook appends a line per decision to `<runRoot>/tmp/hook.log`, but that file is a display aid only: `tmp` is writable by the run's tool children and by the claude process tree, so anything there can be forged or erased. The proof is claude's own stream: every work call runs with `--include-hook-events`, and the run log keeps each `hook_started` and `hook_response` (with the hook's exit code) that claude reports. The Task 11 smoke run requires those events.

**claude's temp dir.** The claude process gets its own `<runRoot>/ctmp` as `TMPDIR` and `CLAUDE_CODE_TMPDIR`. The CLI profile reads and writes it; the tool profile denies it by name, so no agent command can plant or read claude's temp files.

**The engine's and other runs' ports by name.** `forbidden()` also refuses a command that names 4770, 11434, the engine's own port or a live run's proxy or broker port next to a loopback host form (`localhost`, `127.*`, `0.0.0.0`, `[::1]`, `::ffff:127.*`). The tool profile denies the same ports, so the broker path has two layers there too.

**Ruling 9 residual: his login inside the claude process tree.** The CLI profile must let `/usr/bin/security` read his login keychain, its search list and the keychain's mach services, because that is how claude finds his login (Task 11). So code running inside the claude process tree could run `security find-generic-password` and read any item his login keychain hands to `security` without a prompt, his `gh` token among them. The barrier is that the model cannot run code there: claude has no Bash or other code tool (`--tools`, `--disallowedTools`, `permissions.deny`), the PreToolUse hook refuses every tool but the file tools and the run tool, the run tool's commands run in the broker under the tool profile (which denies `security`, the keychain files and the keychain's mach services), and the CLI profile lets claude exec only itself, `security`, node (the hook and the MCP server from read-only `ctl/bin`) and `/bin/sh` with its one selected shell. A change that gives claude a code-running tool would open this, so it must not happen.

The control scripts the sandboxed processes run (the hook, the MCP server, the file tool and the guard) are copied into `<runRoot>/ctl/bin` (read-only to both profiles) by `installControlScripts()` in `engine/market/broker.ts`, because both profiles deny reads of his home, where this repository lives.

## Kill switches and caps

| Switch or cap | Where |
|---|---|
| Stop file (`paths().stop`): no new runs, live ones killed within 5 s | `engine/home.ts` `paths`; `engine/market/budget.ts` (state `stopped`, aborts every lease); Task 13 kills runs |
| Global market switch in Settings | Task 40 (Settings), Task 13 (scheduler gate) |
| Per-repo market switch | `shared/types.ts` `Repo.market`; Task 13 |
| City share of the five-hour window (`dayCapPct` 50) and night cap (`nightCapPct` 20) | `engine/settings.ts` defaults; `engine/market/budget.ts` `gate` |
| Hard stop at `hardStopPct` (90) of either window, aborting Claude runs and calls in flight | `engine/market/budget.ts` (state `hard`, `onHardStop`) |
| Concurrency (`claudeConcurrency` 2, `localConcurrency` 1, the plan pool) and one run per repo | `engine/market/budget.ts` `acquire`, `PLAN_POOL`; Task 13 |
| Anthropic API daily dollars (`anthropicApi.dailyUsd`) | `engine/settings.ts`; Task 10 |
| One command's time: `MAX_TOOL_MS` (15 minutes), cut down from any longer request | `engine/market/broker.ts` `clampTimeout` |
| Command output: 64 KB per stream to the caller, `MAX_SPOOL_BYTES` (20 MB) per run to the log, then the first and last 4 KB of each call | `engine/market/broker.ts` `Capped`, `Spooler` |
| The file tool's reads capped at 256 KB | `engine/market/file-tool.mjs` `MAX_READ_BYTES` |
| The hook's own 5 s timeout | `engine/market/guard-hook.mjs` |
| At most four concurrent broker calls per run (`MAX_CONCURRENT_CALLS`, then 429) | `engine/market/broker.ts` `startBroker` |
| Processes a command leaves behind are killed after the call | `engine/market/reaper.ts` `reapRun`, `runQuiet` |
| Spawned process groups capped by wall clock and killed as a group | `engine/exec.ts` `realSpawner` (`maxMs`, `kill`) |
| Turn and minute caps of a run | Task 9 and Task 13 (`WorkInput.caps`) |
| Self-halt after three failed inspections in a row or any revert of a city merge | Tasks 15 and 16 (`repo.halted`) |
| Jobs retry once; a failing firm may not bid again | `engine/market/jobs.ts` `transition`; `shared/market-rules.ts` `MAX_ATTEMPTS` |

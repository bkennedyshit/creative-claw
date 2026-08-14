# Verifying the rebrand on Linux

This branch (`creative-claw-rebrand`) moves the fork off the upstream config
directory: it now uses `~/.creativeclaw/creativeclaw.json` instead of sharing
`~/.openclaw` with an installed OpenClaw. That change touches path resolution
used by the entire core test suite, and **the core suite has not been run.**

Everything in here was developed and partially verified on Windows. This document
exists because the remaining verification genuinely cannot happen there.

---

## Why Linux

Two independent reasons:

1. **The core lane will not run on the Windows dev machine.** The test wrapper
   aborts a batch after 120 seconds of silence, and several core suites exceed
   that individually (`src/config/io.compat.test.ts` has three tests that each
   time out at 120s). Roughly 157 migrated core test files were verified by diff
   inspection only, never executed.
2. **A large set of core tests assume POSIX.** Failures already triaged as
   environmental-not-real on Windows: file modes (`0o600` / `0o700`), `/` vs `\`
   separators in launchd/systemd/plist/PATH assertions, SQLite WAL `EBUSY` on
   temp-dir teardown, `/tmp` vs `C:\tmp`, and `stdio` `pipe` vs `inherit`. On
   Linux these should simply pass, which is what makes a Linux run meaningful.

CI truth for this repo is **Linux, Node 24**.

---

## Setup

```bash
git clone https://github.com/bkennedyshit/creative-claw.git
cd creative-claw
git checkout creative-claw-rebrand
pnpm install
```

Node 24 is recommended (22.19+ is the floor). If `pnpm install` fails, retry once,
then report the first actionable error rather than working around it.

### Expect the native engines to be unavailable, and that is fine

`extensions/creative-engines/binaries/` is gitignored (~1 GB) and the compiled
engines there are Windows `.dll` files. On Linux the four engines will report
`available: false`, and the engine-dependent tests are skip-guarded, so the
extension lane will show **more skips than on Windows**. That is expected and is
not a failure. Do not try to provision engines just to run these tests — the
rebrand being verified is path resolution, not FFI.

---

## What to run

Run these in order. Stop and capture output at the first one that fails.

```bash
# 1. Static gates (fast, must be clean)
pnpm tsgo                       # core typecheck - expect 0 errors
pnpm check:import-cycles        # expect 0 runtime value cycles
pnpm tsgo:extensions            # ~545 PRE-EXISTING upstream errors are OK;
                                # creative-engines / gpu-broker / visual-memory must be 0

# 2. The reason we are here: the full core suite
pnpm test                       # if this is too heavy, fall back to pnpm test:serial

# 3. The bundled plugins
pnpm test:extensions
```

`pnpm test` is the correct entry point. **Never invoke `vitest` directly** — bare
`vitest` starts watch mode and will not exit. Never run two test commands
concurrently in one checkout; the Vitest cache races and fails with `ENOTEMPTY`.

One more check that only works on Linux/macOS:

```bash
pnpm format:docs:check          # cannot run on Windows
```

On Windows this dies with `The command line is too long` — the script passes every
doc path to `oxfmt` in one invocation and blows past the CMD 8191-character limit.
That is environmental, not a formatting error.

### The baseline you are comparing against

Measured on Windows, on this branch:

| Gate                                                                | Expected                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm tsgo`                                                         | 0 errors                                                              |
| `pnpm check:import-cycles`                                          | 0 cycles                                                              |
| `pnpm tsgo:extensions`                                              | 545 total, 0 in the three new plugins                                 |
| Extensions lane                                                     | 26 passed + 2 skipped files, 326 passed + 8 skipped tests, 0 failures |
| Targeted core (`paths`, `app-branding`, `config.nix-integration-*`) | 44 passed                                                             |

---

## How to read a failure

Every core test failure falls into one of three buckets. Classify before fixing.

**Bucket 1 — pre-existing, unrelated to the rebrand.** Confirm with an A/B against
the branch this was cut from:

```bash
git stash                       # if you have local edits
git checkout creative-claw-engines
pnpm test <the failing file>    # does it fail here too?
git checkout creative-claw-rebrand
```

If it fails on both branches, it is not ours. Record it and move on.

**Bucket 2 — a test was branded but its production code was not.** This is the
real defect class, and it is a _product_ bug, not just a red test: it means a
Creative Claw install still writes live data into `~/.openclaw`. The signature is
an assertion mismatch between the two directory names, e.g.

```
expected 'C:\srv\openclaw-home\.openclaw\workspace'
      to be 'C:\srv\openclaw-home\.creativeclaw\workspace'
```

Two of these were already found and fixed (`src/agents/workspace.defaults.test.ts`,
`src/skills/lifecycle/source-install.test.ts`). **Fix by branding the production
file**, not by bending the test:

```ts
import { APP_STATE_DIRNAME, APP_CONFIG_FILENAME } from "../infra/app-branding.js";
// path.join(home, ".openclaw", "workspace")  ->  path.join(home, APP_STATE_DIRNAME, "workspace")
```

**Bucket 3 — the path is genuinely legacy or container-fixed.** Some `.openclaw`
literals are _correct_ and must stay literal:

- `src/infra/state-migrations.ts` — migrates data out of the historical directory.
- Container/sandbox skill mount markers (`remote-fs-bridge.ts`, `ssh-backend.ts`,
  `workspace-mounts.ts`, `sandbox-skills.ts`) — a fixed mount convention inside
  the container, not a host config path.
- `LEGACY_STATE_DIRNAMES` / `LEGACY_CONFIG_FILENAMES` in `src/config/paths.ts`.
- `DEFAULT_STATE_DIRNAME` / `DEFAULT_CONFIG_FILENAME` in
  `src/infra/app-branding.ts` — the single place the historical literals are
  pinned, on purpose.

For bucket 3, revert _that test's_ assertion back to the `".openclaw"` literal.
Do not delete, skip, or weaken any test in either bucket.

### Do not add `.openclaw` to `LEGACY_STATE_DIRNAMES`

It looks like the obvious migration shortcut and it is a trap. `resolveStateDir`
**adopts** a legacy directory when the current one is absent, so listing
`.openclaw` there would make a fresh Creative Claw install silently take over an
installed OpenClaw's config — the exact collision this branch removes. There is a
comment at `src/config/paths.ts` saying so; keep it accurate.

---

## Known remaining work: production paths still on the old literal

41 production files still contain a `.openclaw` literal (58 lines). Most are
legitimate. Reviewed by hand, the breakdown is:

| Kind                                       | Count | Action                                     |
| ------------------------------------------ | ----- | ------------------------------------------ |
| Doc comments (`/** ~/.openclaw/agent/ */`) | ~19   | Cosmetic. Update opportunistically.        |
| CLI help text and wizard i18n strings      | ~10   | User-facing and now wrong. Worth branding. |
| Fixed container mount markers              | 5     | **Leave literal.**                         |
| Intentional defaults / legacy migration    | 3     | **Leave literal.**                         |
| Real path construction                     | ~3    | **Brand these.**                           |

The real path-construction candidates to check first:

- `src/agents/tool-display-exec.ts:325` — `segment === ".openclaw"` when
  shortening a displayed path. Cosmetic but user-visible.
- `src/commands/doctor-state-integrity.ts:308` — `[".openclaw"].map(dir => path.resolve(root, entry.name, dir))`.
- `src/config/sessions/session-accessor.ts:2211` — bare literal in a path list.

The user-facing strings worth branding, for reference:
`src/cli/dns-cli.ts:168,265`, `src/cli/program/register.agent.ts:220`,
`register.onboard.ts:102`, `register.setup.ts:25`,
`register.status-health-sessions.ts:328`, and
`src/wizard/i18n/locales/{en,zh-CN,zh-TW}.ts`.

An earlier note in this work described all 23 filtered hits as unbranded path
construction. That was an over-count: most are comments and display strings.

---

## Verifying the branding still resolves consistently

The whole point of the change is that all four values agree. Any drift here is a
split brain and a hard failure:

```bash
node --import tsx -e "import { STATE_DIR, CONFIG_PATH } from './src/config/paths.ts'; import { CONFIG_DIR_NAME, APP_NAME } from './src/agents/config.ts'; console.log(APP_NAME, CONFIG_DIR_NAME, STATE_DIR, CONFIG_PATH);"
```

Expected: `creativeclaw .creativeclaw ~/.creativeclaw ~/.creativeclaw/creativeclaw.json`

Note that on a fresh Linux box `~/.creativeclaw` will not exist yet. The runtime
creates it; there is nothing to migrate, because a fresh machine has no upstream
config to preserve.

---

## Running it in a hosted Linux sandbox instead of dual-booting

Nothing here needs your local machine. A hosted Linux environment can clone the
branch straight from GitHub and run the same commands — no commit or push from you
is required, which is why this document is committed to the repo rather than left
as a local note.

If the sandbox has no GPU, that costs nothing: the engines are unavailable on
Linux anyway (see Setup), and none of the verification above depends on CUDA.

---

## Reporting back

Capture, for each of the three numbered commands: the exact command, the pass/fail
counts, and the full text of any failure. For every failure, state which bucket it
belongs to and the evidence — particularly the A/B result for anything you are
calling pre-existing.

The branch is **not** merge-ready until `pnpm test` is green on Linux with every
remaining failure explicitly classified as bucket 1 or bucket 3.

---

## Rollback

The demo branch was never modified:

```bash
git checkout creative-claw-engines
```

That returns you to the state a demo can be recorded from. To make the runtime use
`~/.openclaw` again, drop the `openclawConfig` block from `package.json` — the seam
falls back to the historical defaults. `~/.openclaw` itself was **copied, never
moved**, so upstream's directory is intact and needs no restoration. `~/.creativeclaw`
can be deleted outright if abandoning the rebrand.

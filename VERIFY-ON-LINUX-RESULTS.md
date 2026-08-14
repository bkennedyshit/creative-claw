# Linux verification results — `creative-claw-rebrand`

Companion to `VERIFY-ON-LINUX.md`. This records an actual Linux run of the
runbook, performed on a hosted Linux sandbox (the exact scenario the runbook
describes: clone the branch, run from GitHub, no local machine needed).

- **Environment:** Linux x64, Node **v24.19.0**, pnpm **11.2.2** (matches the
  `packageManager` pin). Open internet. No GPU (expected — native engines are
  unavailable on Linux and their tests are skip-guarded).
- **A/B baseline:** `creative-claw-engines` (the branch the rebrand was cut
  from), installed and run identically in a separate worktree, used to
  distinguish pre-existing failures from rebrand-introduced ones.

---

## TL;DR

| Gate | Result |
| --- | --- |
| `pnpm install` | ✅ after a **build-config fix** (see below) — was hard-blocked before |
| `pnpm tsgo` | ✅ 0 errors |
| `pnpm check:import-cycles` | ✅ 0 cycles |
| `pnpm tsgo:extensions` | ✅ exit 0 (pre-existing upstream errors tolerated; 0 in the new plugins) |
| Branding consistency one-liner | ✅ `creativeclaw .creativeclaw ~/.creativeclaw ~/.creativeclaw/creativeclaw.json` |
| `pnpm test` (full core suite) | ❌ aborted (SIGABRT) — see failures below |

The core rebrand seam is sound: typecheck, import-cycle, and the four-value
branding check all pass. But `pnpm test` is **not green**, so per the runbook the
branch is **not merge-ready** yet.

The full-suite failure list below is a **lower bound**: the run was aborted by an
environmental hang in the `gateway-server` lane (details in Bucket 3), so lanes
still in flight at abort time may hide additional failures. A clean, complete
list needs a run where that lane can bind loopback sockets (the repo's real CI).

---

## The install blocker (fixed in this change)

A fresh `pnpm install` failed with `ERR_PNPM_IGNORED_BUILDS`, exit 1. Because
every `pnpm <script>` runs a deps-status precheck that re-invokes `install`,
**nothing** could run — not even `tsgo`.

Root cause: `pnpm-workspace.yaml` `allowBuilds` had two unfinished placeholder
values left from the Windows work:

```yaml
better-sqlite3: set this to true or false
sharp: set this to true or false
```

YAML parses those as strings, not booleans, so pnpm refuses to decide. Fixed by
setting both to `true` — `better-sqlite3` is the native SQLite store backing the
visual-memory extension and must compile to be importable; `sharp` is the image
native dep and building it is harmless. After the fix, `better-sqlite3` compiles
cleanly (`gyp info ok`) and `pnpm install` exits 0.

> Note: running install here also rewrote ~470 lines of `pnpm-lock.yaml`
> (re-serialized `overrides`, dropped a `sqlite-vec` optionalDependency, etc.).
> That is environmental drift, unrelated to the `allowBuilds` fix, so the
> lockfile change was **reverted** and is not part of this commit.

---

## Failure classification

14 files / 21 failing test cases were observed before the abort. Each is
classified using the runbook's buckets, with A/B evidence.

### Bucket 1 — pre-existing, not caused by the rebrand
*(fail identically on `creative-claw-engines`)*

| File | Test | Evidence |
| --- | --- | --- |
| `ui/src/i18n/test/translate.test.ts` | keeps shipped locales structurally aligned with English | Fails on base too (locale key drift: 1415 vs 1418 keys). |
| `extensions/vercel-ai-gateway/provider-catalog.test.ts` | falls back from malformed live token metadata | Fails on base too. Unrelated to path/branding. |

**Action:** none required for the rebrand. Track separately.

### Bucket 3 — environmental (this sandbox), not real defects

| File / lane | Symptom | Why environmental |
| --- | --- | --- |
| `src/gateway/server.plugin-node-capability-auth.test.ts` | `listen EADDRNOTAVAIL: address not available ::1` | Sandbox has no IPv6 loopback to bind. |
| `test/scripts/docker-build-helper.test.ts` | expected `''`, got `/etc/profile: line 81: …/.cargo/env: No such file…` | The sandbox `/etc/profile` sources `$HOME/.cargo/env`; under the test's temp `HOME` that file is absent, polluting captured stdout. |
| **`gateway-server` lane (whole lane)** | silent for 300s → **SIGABRT**, which aborted the entire `pnpm test` run | The lane runs HTTP server integration tests (`embeddings-http`, `models-http`, `openai-http`, `openresponses-http`, `probe.auth.integration`) that bind loopback sockets; combined with the `::1` bind failure and a 60s test timeout in the same lane, they hang here. Needs a properly-networked Linux CI to confirm green. |

**Action:** re-run on the repo's real CI (Linux, Node 24) where loopback binding
works, to both clear these and surface any failures the abort hid.

### Bucket 2 — real rebrand-introduced regressions
*(pass on `creative-claw-engines`, fail on `creative-claw-rebrand`)*

#### 2a. Stale / incomplete test branding — **FIXED in this change**

Production is correctly branded (emits `~/.creativeclaw/…`); these tests still
pinned the old literal or half-branded. All now pass after the fix, verified by
re-running each file.

| File | Fix |
| --- | --- |
| `src/agents/sandbox/ssh.test.ts` | Line 337 referenced an undefined `APP_STATE_DIRNAME` (`ReferenceError`). Its sibling assertions and the symlink it sets up use the literal `.openclaw` for the **fixed container `sandbox-skills` mount marker**, which the runbook says must stay literal. Reverted line 337 to `.openclaw` to match. |
| `src/commands/configure.channels.test.ts` | 4 prompt strings pinned `~/.openclaw/openclaw.json`. Now derived from `APP_STATE_DIRNAME`/`APP_CONFIG_FILENAME`, mirroring the production prompt (`shortenHomePath(CONFIG_PATH)`). Fixes 5 failing cases. |
| `src/agents/mcp-oauth.test.ts` | Token dir pinned `${home}/.openclaw/mcp-oauth`. Now `${home}/${APP_STATE_DIRNAME}/mcp-oauth` (production uses `resolveStateDir()/mcp-oauth`). |
| `src/commands/agents.commands.list.test.ts` | Human-output assertion pinned `~/.openclaw/workspace` + `~/.openclaw/agents/main/agent`. Now derived from `APP_STATE_DIRNAME`. |
| `src/agents/embedded-agent-runner/run.overflow-compaction.test.ts` | `endsWith("/.openclaw/agents/main/agent")` → `endsWith(\`/${APP_STATE_DIRNAME}/agents/main/agent\`)`. |

#### 2b. Production / logic regressions — **NOT fixed, need maintainer decisions**

These pass on base and fail on the rebrand, i.e. the path/config changes broke
real behavior. They need code changes and, in one case, a product decision.

| File | Test | Analysis |
| --- | --- | --- |
| `src/gateway/session-transcript-files.fs.ts` (via `session-utils.fs.test.ts`) | fallback candidate uses OPENCLAW_HOME instead of os.homedir() | `resolveSessionTranscriptCandidates` builds its final fallback as `path.join(home, ".openclaw", "sessions")` (line ~172). The **test expects `APP_STATE_DIRNAME`**, but a code comment calls this the *legacy global sessions directory* for pre-per-agent upgrades. **Conflict to resolve:** if it is truly legacy-compat → keep `.openclaw` literal (bucket 3) and revert the test; if it is the live fallback → brand it (real product bug: a Creative Claw install reads transcripts from `~/.openclaw`). **Maintainer call.** |
| `src/gateway/session-utils.fs.test.ts` | chooses the newest reset archive across candidate roots | Candidate-root ordering changed once both `.openclaw` and `.creativeclaw` roots can appear. Needs code review of the archive-selection ordering. |
| `src/agents/workspace.test.ts` | refuses to accept a wiped skip-bootstrap workspace with only metadata leftovers | Workspace-vanish guard resolves instead of rejecting on the rebrand. Logic regression in the workspace state check. |
| `src/agents/workspace.test.ts` | migrates legacy `onboardingCompletedAt` markers to `setupCompletedAt` | Migration produces `undefined`; the legacy-marker migration path likely keys off the old state dir. |
| `src/agents/bootstrap-files.test.ts` | ignores stale workspace `BOOTSTRAP.md` when legacy setup state is completed | Legacy-setup-state detection (tied to the state dir) no longer suppresses the stale bootstrap file. |
| `src/agents/utils/tools-manager.test.ts` | extracts Windows zip downloads with trusted System32 tools | Resolves the **real** `~/.creativeclaw/agent/bin` instead of the test's temp home — the home/env override seam is not honored by the tools-manager path resolver. |
| `src/agents/session-write-lock.test.ts` | retries when a stale lock report is replaced by a fresh payload-less lock | Stale-lock retry path in `session-write-lock.ts`; possibly timing, needs isolated repro. |

---

## Recommended next steps

1. **Land the fixes in this change** (build-config + 5 branded tests) so Linux
   install works and the stale-test noise is gone.
2. **Run on the repo's real CI** (Linux, Node 24) to get a complete, non-aborted
   failure list — the `gateway-server` lane cannot bind loopback here.
3. **Resolve the 2b items**, starting with the `session-transcript-files.fs.ts`
   legacy-vs-branded decision, then the workspace / bootstrap / tools-manager
   home-seam regressions.
4. Re-run `pnpm test` to green with every remaining failure classified as
   bucket 1 or 3, per the runbook's definition of merge-ready.

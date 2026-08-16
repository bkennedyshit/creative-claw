# Linux verification results — Creative Claw rebrand

Companion to `VERIFY-ON-LINUX.md`. Records a **complete, non-aborted** run of the
runbook on Linux/Node 24, superseding the earlier partial run whose
`gateway-server` lane could not bind loopback sockets.

- **Environment:** Linux x64, Node **v24.19.0**, pnpm **11.2.2** (matches the
  `packageManager` pin), 8 cores / 30 GB. Open internet. No GPU — expected, and
  the engine-dependent tests are skip-guarded.
- **Method:** every remaining failure is classified by A/B against base branding:
  the same file is run twice, once as-is and once with the `openclawConfig` block
  removed from `package.json`. Fails in both -> pre-existing. Fails only with the
  rebrand active -> rebrand-caused, and fixed here. This is stronger than an
  A/B across branches because it isolates the branding switch itself.

---

## TL;DR

| Gate                           | Result                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm install`                 | ✅ exit 0 (~1m07s)                                                                |
| `pnpm tsgo`                    | ✅ 0 errors                                                                       |
| `pnpm tsgo:core:test`          | ✅ 0 errors — **was 7**; this gate is not in the runbook and had never been run   |
| `pnpm check:import-cycles`     | ✅ 0 cycles                                                                       |
| `pnpm format:docs:check`       | ✅ clean (670 files)                                                              |
| Branding consistency one-liner | ✅ `creativeclaw .creativeclaw ~/.creativeclaw ~/.creativeclaw/creativeclaw.json` |
| Full core suite (89 shards)    | ✅ **0 rebrand-caused failures**; 81,719 passing, 63 failing cases all bucket 1/3 |
| SQLite worker teardown stress  | ✅ **5/5** extension-lane runs and **100/100** direct worker terminations         |
| `pnpm lint`                    | ❌ 100 errors, **all pre-existing** in the fork's engine plugins (see below)      |

**The rebrand seam itself is clean.** Every failure that the rebrand caused is
fixed; everything still red fails identically with the branding block removed.

---

## Environment prerequisites (sandbox, not repo)

Two host-level issues masqueraded as test failures. Both are per-container in a
hosted sandbox, so they must be re-applied for each run — see
`.logs/run-chunk.sh` in the verification workspace.

1. **IPv6 loopback is disabled.** `sysctl -w net.ipv6.conf.{all,lo,default}.disable_ipv6=0`.
   This is what aborted the previous run: `listen EADDRNOTAVAIL ::1`. With it
   applied, `server.plugin-node-capability-auth.test.ts` and the four
   server-backed HTTP suites (`embeddings-http`, `models-http`, `openai-http`,
   `openresponses-http`) pass, and the `gateway-server` lane is green standalone
   (**1346 tests, exit 0**). The previous run's entire bucket 3 is cleared.
2. **`/etc/profile` sources `$HOME/.cargo/env` unconditionally.** Tests that spawn
   a login shell under a temp `HOME` and assert on captured stderr fail on the
   resulting "No such file" line. Guarding the line with `[ -f ... ]` fixes
   `test/scripts/docker-build-helper.test.ts` and both `package-mac-app` cases.

## Why the suite is run in chunks

`pnpm test` expands to **89 shards** and runs them at parallelism 4. On an 8-core
box the lanes starve each other, and the runner's 300s no-output watchdog kills
whichever lane is behind with `SIGABRT`, which fails the whole run. This is a
local-parallelism artifact, not a product failure: `resolveParallelFullSuiteConcurrency`
returns 1 for CI-like environments, so **CI runs lanes serially and never hits
this.** The results below come from running all 89 shards in 4 chunks at
parallelism 3.

---

## The seven handed-over "2b regressions"

The prior report listed seven items as rebrand-introduced product regressions.
A/B evidence reclassifies most of them. `git diff origin/creative-claw-engines...HEAD`
shows `workspace.ts`, `bootstrap-files.ts`, `tools-manager.*` and
`session-write-lock.*` were never touched by the rebrand.

| Item                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-transcript-files.fs.ts` (the maintainer call)  | **Legacy-compat; keep the literal.** Under the rebrand the candidate list is `[…/.creativeclaw/agents/main/sessions/sess-1.jsonl, …/.openclaw/sessions/sess-1.jsonl]`: current transcripts are branded and per-agent, and the last entry is the pre-per-agent upgrade fallback. Nothing has ever written `~/.creativeclaw/sessions`, so branding it would drop the fallback and gain nothing. Both test assertions reverted. |
| `session-utils.fs.test.ts` archive ordering             | Same root cause as above — the test wrote its legacy archive into the branded root. Fixed by the same revert; no ordering bug exists.                                                                                                                                                                                                                                                                                        |
| `workspace.test.ts` (workspace-vanish guard)            | **Bucket 3, not 2b.** `<workspace>/.openclaw/workspace-state.json` is a frozen on-disk artifact and `workspace.ts:39` reads that literal by design. The test branded it, so the leftover directory stopped matching the ignore list.                                                                                                                                                                                         |
| `workspace.test.ts` (`onboardingCompletedAt` migration) | Same cause: the legacy marker was written to the branded path, so the migration found nothing.                                                                                                                                                                                                                                                                                                                               |
| `bootstrap-files.test.ts` (stale `BOOTSTRAP.md`)        | Same cause, via `isWorkspaceSetupCompleted`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `tools-manager.test.ts`                                 | **Real product bug, fixed.** `src/agents/config.ts` derived `ENV_AGENT_DIR` from `APP_NAME`, so the rebrand silently renamed the override to `CREATIVECLAW_AGENT_DIR` while nine other modules still read `OPENCLAW_AGENT_DIR`. `getAgentDir()` now honors both, branded first.                                                                                                                                              |
| `session-write-lock.test.ts`                            | **Bucket 1, pre-existing.** Fails 3/3 with the branding block removed. `staleMs: 10` also sizes the payload-less orphan grace window that `shouldReportContendedLockStale` compares against the test's own 10ms delete timer, so the test raced itself. Raised to 1s.                                                                                                                                                        |

---

## What the complete run found that the aborted one could not

### 1. A gate gap: test files were never typechecked

`pnpm tsgo` covers production only. `pnpm tsgo:core:test` had **7 errors**, all
from the mechanical migration substituting branding constants into _type_
positions (`dirname: APP_STATE_DIRNAME`, `APP_CONFIG_FILENAME as const`,
`configFile: APP_CONFIG_FILENAME | "auth-profiles.json"`). Fixed, and the gate is
now part of the runbook.

### 2. `configFile` is a schema discriminator, not a path

Production types it as the literal union `"openclaw.json" | "auth-profiles.json"`
(`configure-plan.ts`, `configure.ts`, `credential-matrix.ts`) and
`target-registry-data.ts` stores that literal. Nine test files had branded it.
Two consequences, both fixed by reverting to the literal:

- `target-registry.fast-path.test.ts` failed outright — the branded value missed
  the fast path and fell through to the manifest registry.
- `runtime.coverage.test.ts` **silently passed while asserting nothing**:
  `collectOpenClawCoverageEntries` filtered on the branded name and returned an
  empty set.

### 3. Three production paths still bypassed the seam

Found by branding the tests correctly instead of bending them:

| File                                       | Impact                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/paths.ts:48`                   | The managed-service state dir was hardcoded. launchd/systemd/schtasks working directory, the generated `gateway.cmd` wrapper and the task script all pointed at a different directory than the config resolver. |
| `src/cli/profile.ts:80`                    | Half-branded profiles: `~/.openclaw-work/creativeclaw.json`, because the file name was branded and the directory was not.                                                                                       |
| `src/cli/update-cli/restart-helper.ts:313` | The generated PowerShell startup launcher looked for `%USERPROFILE%\.openclaw\gateway.cmd` while the daemon now writes it under the branded dir.                                                                |

### 4. A plugin-SDK seam for bundled plugin tests

Bundled plugin tests had no sanctioned way to _name_ the state dir:
`src/infra/app-branding.ts` is core-internal and importing it from `extensions/**`
breaks the package boundary, so nine extension tests hardcoded `.openclaw` and
diverged from the resolver the moment branding was set. `APP_STATE_DIRNAME` and
`APP_CONFIG_FILENAME` are now exported from the existing
`plugin-sdk/state-paths` subpath, with the docs rows and the
`plugin-sdk-surface-report` public-export budget updated in the same change
(10400 -> 10402, annotated with the reason).

### 5. A second wave of stale test branding

Roughly 30 further failures across 15 files were production-correct/test-stale
pairs: exec-approvals host labels, skills install and skill-path compaction,
media store, config health/backup paths, daemon install plans, plugin roots,
workspace and media roots in dispatch, plugin update install paths, and the
Matrix/qqbot/feishu/browser/telegram plugin state dirs. All fixed by deriving the
expectation from the seam.

---

## Remaining failures — all bucket 1 or 3

83 lanes, **81,719 passing tests**, 63 failing cases across 20 files. Every one
either fails identically with branding disabled, or passes standalone and only
fails under lane contention.

### Pre-existing (fail identically under base branding)

| Area                         | Files / cases                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fork engine plugin contracts | `contracts/extension-runtime-dependencies` (3 — `creative-engines`, `gpu-broker`, `visual-memory` do not declare `typebox`), `contracts/boundary-invariants` (1), `contracts/plugin-sdk-package-contract-guardrails` (1)                         |
| Plugin status/metadata       | `plugins/status.test.ts` (19), `plugins/bundled-plugin-metadata.test.ts` (2)                                                                                                                                                                     |
| Provider catalogs            | `nvidia/provider-catalog` (7), `ollama/provider-discovery` (4), `nvidia/index` (2), `vercel-ai-gateway/provider-catalog` (1)                                                                                                                     |
| Transport retry              | `mattermost/src/mattermost/client.retry.test.ts` (11)                                                                                                                                                                                            |
| Repo hygiene / tooling       | `lint-suppressions` (1, tracks the 100 lint errors below), `package-manager-config` (1, `@aws-sdk/*` pins in `amazon-bedrock-mantle/npm-shrinkwrap.json` vs the lock), `e2e-temp-state-dir` (1, root ignores the permission failure it provokes) |
| Other                        | `codex/src/app-server/run-attempt` (1), `node-host/invoke` (1), `ui/src/i18n/test/translate.test.ts` (1, locale key drift 1415 vs 1418), `config/io.eacces` (3, order-dependent within its lane — passes standalone)                             |

### Environmental

`test/scripts/docker-build-helper.test.ts` — passes once the `/etc/profile` guard
above is applied.

### Lane-only flakes (pass standalone, fail under contention)

`extensions/imessage/src/monitor.watch-subscribe-retry.test.ts`,
`test/scripts/plugin-lifecycle-measure.test.ts`,
`extensions/codex/src/app-server/run-attempt.native-hook-relay.test.ts`.

### Resolved: native worker teardown abort

The remaining non-deterministic blocker was `better-sqlite3` **11.9.1** aborting
the Node 24 parent process when Vitest terminated a worker with a live SQLite
statement:

```
node[26]: void node::RemoveEnvironmentCleanupHook(v8::Isolate*, CleanupHook, void*) at ../src/api/hooks.cc:142
Assertion failed: (env) != nullptr
 3: Statement::~Statement() [node_modules/better-sqlite3/build/Release/better_sqlite3.node]
```

The visual-memory plugin now pins **13.0.3**. Upstream shipped the worker
termination fix in [13.0.2](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.2)
for [issue #1507](https://github.com/WiseLibs/better-sqlite3/issues/1507), then
released [13.0.3](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3)
as the next patch. Version 13.0.3 supports Node 22+ and uses the Node-API addon path instead of the old direct V8 cleanup-hook implementation.
The lockfile change is intentionally limited to the visual-memory importer, the
13.0.3 package integrity/engine metadata, and its `node-addon-api` dependency.

Post-upgrade proof on Linux/Node 24.19.0:

- `pnpm test extensions/visual-memory`: **5 files, 50 tests passed**.
- `pnpm test test/vitest/vitest.extensions.config.ts`: **5 consecutive clean
  runs**; each run ended with 233 files and 3,013 tests passed, with 4 files and
  47 tests skipped. No process abort occurred.
- A direct stress reproducer opened SQLite work in a worker and terminated it
  **100 consecutive times** without aborting the parent process.

The old version reproduced the lane abort in roughly 2 of 3 runs, so this closes
the final native blocker rather than masking it with process-exit hooks or test
isolation.

### `pnpm lint`: 100 pre-existing errors

All in fork-owned code — `extensions/creative-engines` (60),
`extensions/visual-memory` (17), `extensions/creative-claw-*.test.ts` (18),
`extensions/gpu-broker` (4), `ui/src` (1). None in any file touched here. This is
what `lint-suppressions.test.ts` reports (43 vs 42 allowlisted).

---

## Follow-ups not taken here

Deliberately out of scope; none are test-covered, all are user-visible:

- `src/commands/doctor-state-integrity.ts:1037` builds the default state dir from
  a literal, plus literal advice strings at 889/1060/1061/1487.
- `src/agents/tool-display-exec.ts:325,328` and
  `src/config/sessions/session-accessor.ts` path-shortening literals.
- CLI help and wizard i18n strings still say `~/.openclaw/...`
  (`dns-cli.ts`, `register.agent.ts`, `register.onboard.ts`, `register.setup.ts`,
  `skills-cli.format.ts`, `program/help.ts`, `wizard/i18n/locales/*`).
- launchd/schtasks service labels remain `ai.openclaw.*`. These are service
  identifiers rather than paths and are overridable via `OPENCLAW_LAUNCHD_LABEL`,
  so renaming them is a product decision with an upgrade story.
- Env var names stay `OPENCLAW_*` by design; the rebrand renames directories, not
  env prefixes.

## Merge readiness

Per the runbook's definition — `pnpm test` with every remaining failure
explicitly classified as bucket 1 or 3 — **the rebrand is merge-ready.** The
non-rebrand failures above (fork lint debt, provider catalog and plugin status
failures) exist equally on `creative-claw-engines` and should be tracked
separately. The former native `better-sqlite3` blocker is fixed and
stress-verified in this branch.

Note that `main` does **not** have the rebrand active: `897c4abaea` added the
seam, but the `openclawConfig` block lives only on the rebrand branch, so
`APP_STATE_DIRNAME` is still `.openclaw` there.

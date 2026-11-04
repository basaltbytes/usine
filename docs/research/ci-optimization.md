# CI speed and organization

Research date: 2026-11-04. Versions: turbo 2.11.10, vitest 5.0.5, `@vitest/browser-playwright` 5.0.5, pnpm 11.20.0, TypeScript 7.0.2, `@effect/tsgo` 0.64.1.

Sources:

- The last 60 runs of `ci.yml` on basaltbytes/usine, created between 2026-11-03 12:39 and 2026-11-04 08:02 UTC. They were read with `gh run list` and `gh run view --json jobs`, and the full logs of the 49 runs that reached a conclusion were downloaded with `gh run view --log`.
- The repository's Actions cache listing (`gh cache list`, `GET /actions/cache/usage`).
- `turbo run --dry=json` experiments in a worktree.
- The workflow files of 13 TypeScript and Rust monorepos, and the primary docs of Turborepo, Vitest, GitHub Actions, Playwright, pnpm, and the third-party runner vendors.

Claims that no run or primary source confirmed are listed in [Unverified claims](#unverified-claims).

## Recommendation

- Split the single `ci` job into one static-checks job and a test matrix of four legs grouped by package, plus an aggregate gate job. This is the largest gain.
  - The test step is 75% of a pull request run.
  - Its package suites run one after another (`--concurrency=1`) on a 4-vCPU runner.
  - The two longest suites, `@usine/web` (146 s) and `@usine/server` (120 s), run on nearly every pull request.
  - In parallel legs, the critical path drops from a median of 546 s to an estimated 200–230 s.
  - Standard runners are free on this public repository, so the extra job-minutes cost nothing.
- In the same change, exclude test files from the turbo `build` inputs. Today a test-only edit in `@usine/engine` changes the build hash of `@usine/engine`, and with it the hash of every dependent build, check, and test: 18 of 51 tasks (measured with `--dry=json`).
- Then shorten the long-pole test files and shard the browser suite. Single files bound each package:

  | File | Package | Duration |
  | --- | --- | --- |
  | `lifecycle.test.ts` | server | 81 s |
  | `cloudflare.test.ts` | executor | 78 s |
  | `upgrade/helper.test.ts` | server | 70 s |
  | `conversation.browser.test.tsx` | web | 49 s |

- Take the timing-sensitive `operator-read-latency.test.ts` out of the pull request gate. It failed 2 of the 49 runs at a 500 ms budget.
- Consider a turbo remote cache third. It shares builds across matrix legs and pull requests, and it replaces `.turbo` entries in the Actions cache. Those entries hold 6.7 GB of the repository's 11.28 GB, which is already over the 10 GB default limit.
- Don't buy larger or third-party runners yet. Long single files and a hardcoded `maxWorkers: 2` bound the suites more than core count does, and parallel standard jobs are free.

## Current state

### Workflows

| Workflow | Trigger | Shape | Median wall clock |
| --- | --- | --- | --- |
| `ci.yml` | `pull_request`, push to `main`, dispatch | One job `ci` on `ubuntu-latest`. Node 22 on pull requests, Node 24 on `main` (`ci.yml:18`). | PR 546 s, main 587 s |
| `release.yml` | push to `main` | `changes` → `release` (changesets) → `next` (prerelease publish). Doesn't wait for CI. | 6–8 min; `next` publish step 264 s |
| `deploy-docs.yml` | push to `main` with path filter | One job: install, `turbo run build --filter=@usine/docs`, deploy. | 67–88 s |
| `worker-image.yml` | PR and push with path filter `infra/worker-image/**` | Two-architecture Docker build. | Not on the usual PR path |

The repository is public (`gh api repos/basaltbytes/usine` reports `visibility: public`). Public repositories get 4-CPU, 16 GB Linux runners, and standard runners are "free and unlimited on public repositories" ([GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).

Commit `349462fe` (#517) cut CI down to one Node version per event because "October used 3126 Actions minutes on this repository against 2000 included". That constraint doesn't apply to a public repository on standard runners.

`main` has no branch protection and no rulesets: `GET /branches/main/protection` returns 404, and `/rulesets` and `/rules/branches/main` return `[]`.

### Steps of the `ci` job

All durations are in seconds, taken from step `startedAt` and `completedAt` of successful runs: 34 pull request runs and 11 push runs. Queue time runs from the run's `createdAt` to the job's `startedAt`.

| Step | PR median | PR p90 | Main median | Main p90 |
| --- | ---: | ---: | ---: | ---: |
| Queue | 4 | 4 | 3 | 4 |
| Set up job, checkout | 3 | 9 | 3 | 11 |
| `pnpm/action-setup` | 4 | 6 | 4 | 7 |
| `actions/setup-node` (includes the pnpm store restore, 438–553 MB) | 10 | 13 | 14 | 14 |
| `actions/cache` restore, `.turbo` and Playwright (each) | 4 | 9 | 2 | 5 |
| `pnpm install --frozen-lockfile` | 8 | 12 | 8 | 15 |
| Validate changesets | 2 | 2 | – | – |
| Effect baseline diff | 0 | 0 | – | – |
| `pnpm lint` | 3 | 3 | 3 | 4 |
| `pnpm format:check` | 1 | 2 | 1 | 1 |
| `pnpm knip` | 4 | 5 | 4 | 4 |
| `pnpm build` | 28 | 38 | 30 | 40 |
| `pnpm check` | 26 | 40 | 27 | 44 |
| Playwright `install-deps` (browser cache hit, 29 of 34 runs) | 13 | 27 | 12 | 14 |
| Playwright `install --with-deps` (cache miss, 5 of 34 runs) | 21 | 29 | 22 | 22 |
| **`pnpm test`** | **407** | **615** | **465** | **623** |
| Post steps (cache save and others) | 2–4 | 6–12 | 1–3 | 5–10 |
| **Job total** | **542** | **760** | **584** | **770** |

The test step is 75% of the median pull request job and 80% of the median main job. Everything before it, including build and check, takes about 2 minutes. Queue time is negligible.

The step is two commands in sequence (`package.json:16`):

1. `node --test` over the root script tests: a median of 24.3 s and p90 of 25.5 s over 36 runs. Turbo doesn't run this command, so it runs uncached on every run, docs-only changes included. The slowest cases are the Hetzner gateway tests at 1.6–2.3 s each.
2. `turbo run test --concurrency=1`.

### Package test suites

These durations are vitest's own `Duration` line, read from the runs where turbo executed the task (a cache miss). "Executed" counts misses out of the runs where the task appeared.

| Package | Executed | Median (s) | p90 (s) | Files | Longest file (median) |
| --- | ---: | ---: | ---: | ---: | --- |
| `@usine/web` | 45 / 47 | 146.3 | 158.2 | 57 | `conversation.browser.test.tsx` 49 s |
| `@usine/server` | 43 / 45 | 119.8 | 140.5 | 44 | `lifecycle.test.ts` 81 s |
| `@usine/executor` | 24 / 47 | 78.1 | 85.7 | 33 | `cloudflare/cloudflare.test.ts` 78 s |
| `@usine/engine` | 31 / 47 | 53.8 | 77.3 | 25 | `store/sqlite-concurrency.test.ts` 45 s |
| `@usine/orchestrator` | 41 / 47 | 51.7 | 65.7 | 54 | `ci.test.ts` 22 s |
| `@usine/durable` | 23 / 47 | 19.6 | 20.1 | 5 | `attempt-runtime.test.ts` 18 s |
| `create-usine` | 44 / 46 | 17.7 | 21.3 | 1 | `scaffold.test.ts` 19 s |
| `@usine/gateway` | 17 / 47 | 7.3 | 8.6 | 13 | `main.test.ts` 5 s |
| `@usine/agents` | 19 / 47 | 3.9 | 4.7 | 13 | |
| `@usine/github` | 28 / 47 | 2.8 | 3.5 | 8 | |
| `@usine/config` | 18 / 47 | 2.7 | 3.1 | 5 | |
| `@usine/cloudflare` | 20 / 47 | 2.3 | 2.7 | 7 | |
| `@usine/core` | 17 / 47 | 1.4 | 1.9 | 9 | |
| `@usine/docs` | 43 / 47 | 1.0 | 1.1 | 2 | |
| `@usine/expression` | 11 / 47 | 0.4 | 0.5 | 1 | |

Weighting each median by how often the task ran gives about 410 s of vitest time per run. That is the same order as the measured step median of 407 s.

`@usine/web`, `@usine/server`, `@usine/orchestrator`, and `create-usine` run on almost every pull request: 337 s together, plus 24 s of root tests. That six-minute floor applies to any change in any package's source.

Slowest test files, as the median over seven full runs (log lines `✓ <file> (N tests) <ms>`):

| Median (s) | Package | File |
| ---: | --- | --- |
| 80.8 | server | `test/lifecycle.test.ts` (21 tests) |
| 78.4 | executor | `test/cloudflare/cloudflare.test.ts` (16 tests) |
| 69.6 | server | `test/upgrade/helper.test.ts` (40 tests) |
| 54.4 | server | `test/configuration.test.ts` (9 tests) |
| 49.4 | web | `src/components/runs/transcript/conversation.browser.test.tsx` (50 tests) |
| 44.8 | engine | `test/store/sqlite-concurrency.test.ts` (7 tests) |
| 44.5 | web | `src/components/needs-you/needs-you.browser.test.tsx` (16 tests) |
| 40.3 | web | `src/features/configuration/components/editor/entity.browser.test.tsx` (40 tests) |
| 27.8 | executor | `test/ssh/codex-connection.test.ts` (13 tests) |
| 21.5 | orchestrator | `test/ci.test.ts` (18 tests) |
| 19.0 | create-usine | `test/scaffold.test.ts` (11 tests) |
| 18.3 | durable | `test/attempt-runtime.test.ts` (49 tests) |
| 17.8 | server | `test/export-run.test.ts` |
| 15.7 | server | `test/backup.test.ts` |

The sum of file durations across all packages is 921 s. Vitest 5.0.5 defaults to `availableParallelism() - 1` workers outside watch mode (`getDefaultMaxWorkers` in `vitest/dist/chunks/index.1TqnEahn.js:1622`), which is 3 on the 4-CPU runner. At 3 workers, 921 s of file time is 307 s of ideal wall clock. A full run spends about 570 s, so worker utilization is about 54%. Each package ends with a tail where one long file runs while the other workers wait. For example, executor's `cloudflare.test.ts` takes 78 s of the package's 86 s.

## Findings

### F1. Package suites run serially on one runner

`package.json:16` runs `turbo run test --concurrency=1`. Commit `6212d13d` (#361, "Keep the full test gate from timing out on a busy machine") introduced it, together with 30 s test timeouts in `engine`, `executor`, and `orchestrator` and `maxWorkers: 2` in `apps/web/vitest.config.ts:85`. The serial order protects suites that run real processes, SQLite, and cryptography from CPU contention. The cost is that the 146 s browser suite and the 120 s server suite never overlap.

On separate runners, the contention that #361 avoided doesn't arise, because each leg gets its own 4 CPUs.

### F2. Test-only edits invalidate every dependent package

The `build` task's inputs are `$TURBO_DEFAULT$` minus the README and changelog (`turbo.json:6`). That set includes `test/**`, colocated `*.test.tsx` files in `apps/web/src`, `vitest.config.ts`, `tsconfig.check.json`, and `effect-baseline.json`. `tsc -b` compiles only `src` (`tooling/tsconfig/build.json`, `"include": ["${configDir}/src"]`), so none of those files affect `dist`.

A task's hash includes the hashes of the tasks it depends on (`dependsOn: ["^build"]`). Measured with `turbo run test check build --dry=json` before and after appending a comment to `packages/engine/test/drain.test.ts`, 18 of 51 task hashes changed:

- `build`, `check`, and `test` of `engine`, `orchestrator`, `server`, `web`, `docs`, and `create-usine`.
- The correct set is `@usine/engine#check` and `@usine/engine#test`.

On today's serial runner, the extra tasks add about 5.5 minutes to a test-only engine change.

### F3. A few files and a hardcoded worker limit bound each suite

Within a package, vitest parallelizes across files and runs a file's tests in order. Single files therefore set each package's floor:

- `lifecycle.test.ts` takes 81 s of server's 120 s. It runs 21 scenarios that each spawn the CLI and a server process through `execFile`, and some wait out stop timeouts on purpose (`apps/server/test/lifecycle.test.ts:130`, `:398`, `:419`).
- `cloudflare.test.ts` takes 78 s of executor's 86 s, at 5–9 s per scenario against a fake Worker HTTP server (`packages/executor/test/cloudflare/fake-worker.ts:239`).

The browser suite runs 57 files at `maxWorkers: 2`, and vitest attributes 89–90% of its duration to `worker`. `optimizeDeps: { force: true }` (`apps/web/vitest.config.ts:100`) re-bundles Vite's dependencies on every run. Its cost wasn't measured.

### F4. One latency test flakes

`apps/server/test/operator-read-latency.test.ts:65` sets a 500 ms read budget. It failed in runs [41654838698](https://github.com/basaltbytes/usine/actions/runs/41654838698) and [41668105260](https://github.com/basaltbytes/usine/actions/runs/41668105260): the fastest overview read was 528 ms and 515 ms. That is 2 of 49 runs, about 4%, and each failure cost a full 9-minute rerun. In the factory, it also produces a CI failure that a fix run then has to look at. The server config already isolates the test in its own project that runs last (`apps/server/vitest.config.ts:19-20`), but it still shares a 4-CPU runner with whatever else is running.

The other two failures in the window were real: a Dependabot `effect` bump broke the `@usine/github` build.

### F5. The turbo cache crosses Node versions and grows without bound

The cache step (`ci.yml:36-41`) saves `.turbo` under a new key on every run. Its restore keys fall back from `turbo-Linux-ci-node22-` to `turbo-Linux-`. A pull request's caches are scoped to `refs/pull/N/merge`, and main never saves a Node 22 entry. So the first run of every pull request restores main's Node 24 cache. Examples: [41788496667](https://github.com/basaltbytes/usine/actions/runs/41788496667) restored `turbo-Linux-ci-node24-6e60662d…`, and 41731742934 restored `turbo-Linux-ci-node24-839720c6…`.

12 of the 38 pull request runs with logs in the window did this. Turbo doesn't hash the Node runtime version: `globalCacheInputs.engines` is the `engines` field, not the running Node. A test task that hits that cache replays a result produced on Node 24. The comment at `ci.yml:3-5` says pull requests test on Node 22, but that holds only for packages the pull request changed.

Nothing ever prunes `.turbo/cache`, so each saved entry is the restored entry plus new artifacts:

- On 2026-11-03, the `refs/pull/908` entries reached 960–971 MB.
- The main lineage started over at 6 MB after run [41670421550](https://github.com/basaltbytes/usine/actions/runs/41670421550) found no cache, and it has grown to 51 MB since.
- The repository holds 58 entries, 11.28 GB in total: 6.4 GB of `turbo-Linux-ci-node22-*`, 2.7 GB of pnpm store, and 1.8 GB of Playwright browsers. That is over the 10 GB default.

GitHub evicts least-recently-used entries when a repository is over the limit ([Dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)). Eviction can remove main's entries, which every pull request's first run depends on.

### F6. The Playwright cache key churns, and the OS packages install on every run

The browser cache key is `hashFiles('pnpm-lock.yaml')` (`ci.yml:47`). Any lockfile change creates a new 293 MB entry, and there are six in the cache now. A hit saves 8 s: a 13 s median for `install-deps` against 21 s for `install --with-deps`. The apt step runs either way.

Playwright's CI guide says "Caching browser binaries is not recommended" because "the amount of time it takes to restore the cache is comparable to the time it takes to download the binaries" ([Playwright CI](https://playwright.dev/docs/ci)). The measurements here agree. vitejs/vite and vitest-dev/vitest key the browser cache by Playwright version instead, and vitest runs browser jobs in a prebuilt container so that `install-deps` never runs ([vitest setup-playwright](https://github.com/vitest-dev/vitest/blob/b48989f6e07757ca79f155654844018dd0bcdaf5/.github/actions/setup-playwright/action.yml)).

### F7. Duplicated work

- Type checking runs twice. `build` runs `tsc -b` over `src`, and `check` runs the Effect-patched compiler over `src` and `test` (`scripts/effect-diagnostics/check.mjs:30`). On cold runs, the two steps take 55–70 s together.
- `@usine/docs#build` runs `pnpm test` before generating the site (`apps/docs/package.json:10`), so the docs tests run in both `build` and `test`. That costs about 1 s. The docs build also hashes `apps/server/src/**` (`turbo.json:26`), so it misses on 44 of 47 runs.
- The root `node --test` suites (24 s) run on every run because turbo doesn't run them (F1).

### F8. Test logs are 80,000 lines per run

Passing tests print Effect `INFO` logs to stdout. In one full main run, the line counts per test task were 31,891 for `server`, 16,886 for `orchestrator`, 16,500 for `executor`, and 13,471 for `engine`. Each run log is about 9 MB. Vitest 5 supports `silent: 'passed-only'`, which keeps console output from failing tests only (`vitest/dist/chunks/plugin.d.C8mmycim.d.ts:3742`). The time cost of the output wasn't measured.

### F9. The factory reads CI through the status rollup

`GitHubChecks.snapshot` reads `statusCheckRollup { state }` for the pull request head (`packages/github/src/checks.ts:45`, `:163-174`) and maps it to `pending`, `success`, or `failure`. On failure, `failures` lists the failed check runs for the head, takes up to four (`checks.ts:200`), and downloads each one's run-attempt log archive to excerpt the failed steps.

A matrix doesn't change the success path, because the rollup already covers every check on the commit. On the failure path, the excerpts improve: they name the failed leg, for example `test (server)`, instead of `ci`. Two behaviours need a check before the split; see [Unverified claims](#unverified-claims).

### F10. Smaller organizational gaps

- The concurrency group `ci-${{ github.ref }}` cancels in-progress runs on `main` as well (`ci.yml:13-15`). That didn't happen in this window, but a cancelled main run leaves a commit with no full result. Turborepo, oxc, and pnpm cancel only pull request runs.
- The 8 runs on `changeset-release/main` ended `action_required` with actor `github-actions[bot]`, so the version pull request never runs CI.
- Agents push often. In the window, `fix/905-github-transient-retry` had 8 CI runs totalling 75 minutes, and `fix/894-sqlite-event-loop` had 6 runs totalling 62 minutes.

## Options

The ranking is by expected pull request wall-clock gain per unit of effort. The gains are estimates built from the medians above. The critical-path model for one leg is the sum of:

- Setup, about 33 s: set up job, checkout, pnpm, Node with the pnpm store, cache restores, and install.
- The turbo builds the leg's packages need. Measured at a full miss, building through `orchestrator` takes 24 s and building through `server` (which includes the web build) takes 41 s.
- The leg's tests.
- About 5 s of post steps.

| Rank | Option | PR gain (median) | Main gain | Effort | Risk | Ongoing cost |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Parallel jobs: static job plus a 4-leg test matrix and a gate job | 546 s → about 220 s (−5.4 min). p90 760 → about 260 s. | Same | 1 PR, workflow only | Low | $0 on standard runners. About 13 job-minutes per run instead of 9.5. |
| 2 | Exclude tests and test config from `build` inputs | Test-only edits in shared packages skip dependent suites: about −5.5 min today, about −2 min after option 1. Other PRs: 0. | Same | A few lines in `turbo.json` | Low | None |
| 3 | Split the long-pole files; raise web workers in its own leg; shard web | About 220 → 150–180 s after option 1 | Same | 1–2 PRs of test file moves | Medium: contention timeouts like #361 | None |
| 4 | Move the latency test out of the PR gate | Removes a 4% rerun rate: about −20 s per run on average, and fewer false fix runs | Runs there instead | Tiny | Low | A main-only or scheduled job |
| 5 | Turbo remote cache | −20 to −35 s per leg (cached builds). First pushes reuse other PRs' results. Ends the cache-limit evictions. | Same | 1 PR plus account setup | Medium: cache poisoning from PR writes | Vercel free, or self-hosting |
| 6 | Hash the Node major into turbo (`globalEnv`) | Negative: the first push of each PR runs every suite. After option 1, the extra suites run off the critical path. | 0 | Tiny | Low | None. Correctness fix for F5. |
| 7 | Quiet passing-test logs (`silent: 'passed-only'`) | Small, not measured | Same | Tiny | Low | None |
| 8 | Run root script tests through turbo, or in a static-job step | −24 s on runs where nothing they test changed | Same | Small | Low | None |
| 9 | Playwright: key by version, or use the Playwright container | −8 to −13 s on the web leg | Same | Small | Low | None |
| 10 | Avoid the double type check | −20 to −30 s on cold runs, off the critical path after option 1 | Same | Medium | Medium | None |
| 11 | `turbo --affected` on PRs | About 0 while caches hit. It doesn't reduce the dependency fan-out. | – | Small | Low | Needs a deeper fetch |
| 12 | Merge queue | Negative for PR latency: adds a queue run after approval | – | Medium; the factory must enqueue | Medium | None |
| 13 | Larger or third-party runners | Small: single files and `maxWorkers: 2` bound the suites | Same | Small | Low | About $160–430 per month at this volume |

### 1. Parallel jobs

The proposed layout:

| Job | Contents | Estimated duration |
| --- | --- | --- |
| `static` | Changesets, Effect baseline diff, lint, format, knip, build, check, root `node --test` | About 33 + 2 + 3 + 1 + 4 + 28 + 26 + 24 ≈ 120 s |
| `test (web)` | `turbo run test --filter=@usine/web`; Playwright install-deps | 33 + 24 + 13 + 146 + 5 ≈ 220 s (p90 about 250 s) |
| `test (server)` | `--filter=@usine/server`; the latency project runs last, as today | 33 + 41 + 120 + 5 ≈ 200 s (p90 about 225 s) |
| `test (engine)` | `--filter=@usine/engine --filter=@usine/orchestrator --filter=@usine/durable` | 33 + 24 + 54 + 52 + 20 ≈ 185 s when all three miss |
| `test (rest)` | `executor`, `create-usine`, and the remaining small packages | 33 + 41 + 78 + 18 + 20 ≈ 190 s when all miss |
| `ci` | `needs` all of the above with `if: always()`; fails unless every result is `success` or `skipped` | Seconds |

The legs balance at 185–220 s in the worst case. The web leg sets the median. A leg whose packages all hit the cache finishes in about 40 s.

Each leg runs turbo with `--concurrency=1` as today. Within a leg, the packages are smaller than the whole repository, and no other suite competes for the CPU, so #361's reason holds without serializing web against server.

Cache handling: each leg either needs its own turbo cache key, because two jobs can't save the same key, or must restore only. The simplest correct form follows oxc's ([ci.yml](https://github.com/oxc-project/oxc/blob/563cf449a94c6535c1583aa03a111b390b0e4f7e/.github/workflows/ci.yml)): restore on every run with `actions/cache/restore`, and save with `actions/cache/save` only on `main`, under a leg-specific key. This also fixes F5's growth. Pull request reruns then lose their own cache, so a second push of the same pull request reruns what main doesn't cover. That is acceptable at about 220 s, and option 5 removes the cost.

Effect on developers and agents:

- The checks list shows five jobs instead of one.
- A failure names the leg.
- The factory's CI wait drops from about 9 minutes to under 4 for the median pull request.
- Over the window's 34 successful pull request runs, the saving is about 3 hours of agent wait.

The aggregate job pattern comes from Effect-TS/effect (`Types` aggregates the type-check matrix), microsoft/typescript-go (`required`), pnpm/pnpm (`TS CI / Success`), vite, and turborepo. GitHub's troubleshooting guide recommends it because a job skipped through `if:` reports success, while a workflow skipped by a path filter leaves a required check pending ([Handling skipped but required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)).

### 2. Build inputs without tests

Add exclusions to `tasks.build.inputs`:

```json
["$TURBO_DEFAULT$", "!README.md", "!CHANGELOG.md", "!test/**", "!**/*.test.ts", "!**/*.test.tsx",
 "!vitest.config.ts", "!tsconfig.check.json", "!effect-baseline.json"]
```

Keep `@usine/docs#build` as it is, because that build runs the docs tests. The `test` and `check` tasks keep `$TURBO_DEFAULT$`, so they still see their own test files.

Turbo's docs describe `inputs` as an opt-out of the defaults, with `$TURBO_DEFAULT$` restoring them ([Configuration](https://turborepo.dev/docs/reference/configuration)). Verify the change with the same `--dry=json` comparison: after the change, a test edit in `engine` should change 2 hashes, not 18.

### 3. Long-pole files, web workers, and shards

- Split `lifecycle.test.ts`, `upgrade/helper.test.ts`, and `configuration.test.ts` in server, and `cloudflare.test.ts` in executor, into files of 15–25 s. Server's file time is 293 s, which is about 100 s at 3 workers, against 120–140 s today. Executor's is 125 s, about 42 s at 3 workers, against 78 s.
- In its own leg, the web suite no longer has to leave CPU for other packages. The 2-worker cap exists because "browser test workers … oversubscribe the monorepo test run" (`apps/web/vitest.config.ts:84`). At 3 workers, 224 s of file time is about 75 s plus startup.
- If web is still the long pole, shard it into two legs with `vitest run --shard=1/2` and `--shard=2/2` ([Improving Performance: sharding](https://vitest.dev/guide/improving-performance)). Pass or fail needs no merge job. vitest-dev/vitest shards its own browser tests in two ([ci.yml](https://github.com/vitest-dev/vitest/blob/7fa169bae437da7e863e1b908bc7ab4e05020cda/.github/workflows/ci.yml)), as does SvelteKit for Playwright ([ci.yml](https://github.com/sveltejs/kit/blob/15aca36092e6e8ae6df6ab06a2965e3a11228d3a/.github/workflows/ci.yml)).

Vitest shards split files, not tests, so sharding without the file splits leaves the 81 s lifecycle file as server's floor.

The risk is the one #361 met: more processes at once on 4 CPUs can push spawn-heavy tests past their timeouts. Measure each split on CI before raising worker counts further.

Don't turn off isolation. Vitest's hint estimates `isolate: false` would save 0.3–0.5 s per package, and the server, engine, and executor suites rely on per-file process state.

### 4. The latency test

Move `operator-read-latency.test.ts` to a job that runs on `main` or on a schedule. Alternatively, compare against a baseline measured in the same process instead of a fixed 500 ms. The factory treats any red check as a reason to start a fix run, so a 4% false-failure rate on the gate is expensive beyond the rerun.

### 5. Turbo remote cache

- Vercel Remote Cache "is free to use on all plans", and any HTTP server that implements the published API can serve as a self-hosted cache ([Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)). Configure it with `TURBO_TOKEN`, `TURBO_TEAM`, and `TURBO_API` ([system environment variables](https://turborepo.dev/docs/reference/system-environment-variables)).
- vercel/turborepo itself uses an OIDC action to obtain the token, with `TURBO_CACHE: remote:rw` for same-repository pull requests ([turborepo-test.yml](https://github.com/vercel/turborepo/blob/3fbea718802a5d1e4ac7a4e8bad8f948a3439afe/.github/workflows/turborepo-test.yml)). withastro/astro primes the cache in a build job that later jobs hit ([ci.yml](https://github.com/withastro/astro/blob/cf27e70a9057ce29ade2a8a843bd9275a696e9ab/.github/workflows/ci.yml)).
- Gains for this repository:
  - Matrix legs share one build.
  - A pull request's first push reuses results from other pull requests, not only from main.
  - Reruns of a pull request keep their cache under option 1's main-only saves.
  - `.turbo` leaves the Actions cache.
- Cost and risk:
  - A secret and an account, or a small service to run.
  - Cache poisoning: agents push branches inside the repository, so pull request jobs hold the token, and a pull request could write an artifact that `main` later replays. Use `TURBO_REMOTE_CACHE_READ_ONLY` on pull requests and write from `main` only, or accept the risk. A signature key doesn't help when the writer also holds the key ([`remoteCache.signature`](https://turborepo.dev/docs/core-concepts/remote-caching)).
- Lock-in is low: the API is open and the cache is an optimization.

### 6. Node version in the hash

Add `NODE_VERSION` to `globalEnv` and drop the `turbo-${{ runner.os }}-` restore fallback. Pull request results then come only from Node 22 runs. With main-only saves on Node 24, a pull request's first push misses everything. After option 1, the misses add about 0 s to the critical path, because web and server run anyway and the other legs finish within the web leg's time.

The alternative is to state that pull requests test changed packages on Node 22 only. That's a policy choice.

### 7–10. Small fixes

- Set `silent: 'passed-only'` in the four noisy packages' vitest configs, or lower the test logger to warnings. Failure output stays as it is.
- Run the root script tests through turbo, as a root task with explicit `inputs` so that it caches, or keep them in `static`, where they're off the critical path after option 1.
- Key the Playwright cache by the installed Playwright version, or run the web leg in the `mcr.microsoft.com/playwright` image. The Playwright docs recommend `npx playwright install --with-deps` without a cache.
- The double type check is off the critical path after option 1. A compile-only build (`tsc -b` with type checking skipped) needs a check that TypeScript 7 supports it for project builds; see the unverified list.

### 11–13. Options not recommended now

- **`--affected`.** By default, `--affected` equals `--filter=...[main...HEAD]`, and on a shallow checkout it treats every package as changed ([run reference](https://turborepo.dev/docs/reference/run), [constructing CI](https://turborepo.dev/docs/crafting-your-repository/constructing-ci)). Here, the content-hash cache already skips unchanged packages. The cost comes from the dependency fan-out (F2 and the always-run set), which `--affected` reproduces because it also selects dependents. It becomes useful only if caches go missing, for example through eviction. pnpm/pnpm runs affected-only suites on pull requests and the full suite when root inputs change ([test.yml](https://github.com/pnpm/pnpm/blob/7b693e272793f12d2216df59d54ec0c8df0be4fb/.github/workflows/test.yml)); turbo's cache gives the same result here.
- **Merge queue.** A queue must trigger on `merge_group` ([managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)). It pays off when pull requests run a subset and the queue runs the full suite, as in microsoft/typescript-go, which shrinks its matrix under `merge_group` ([ci.yml](https://github.com/microsoft/typescript-go/blob/f7c4664176a1ac8be4ba7b4981d0b17c0457a74c/.github/workflows/ci.yml)). After option 1, the full suite fits in about 4 minutes on every pull request, so a queue would add a second wait after review. It would also need branch protection, which `main` doesn't have, and the factory's merge step would need to enqueue instead of merging. Revisit it if pull requests move to affected-only runs.
- **Larger and third-party runners.** Larger GitHub runners aren't free for public repositories and need a Team or Enterprise plan; 8-core Linux x64 costs $0.022 per minute ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)). Third-party options:
  - Namespace: 8 vCPU at $0.008 per minute prepaid ([pricing](https://namespace.so/pricing)).
  - Blacksmith: x64 from $0.004 per minute, 3,000 free minutes per month ([pricing](https://www.blacksmith.sh/pricing)).
  - Depot: 8 vCPU at $0.024 per minute ([pricing](https://depot.dev/pricing)).
  - BuildJet shut down on 2026-03-31 ([announcement](https://buildjet.com/for-github-actions/blog/we-are-shutting-down)).

  At about 70 runs and 650 job-minutes a day (60 runs in 19.4 hours here), 8 vCPU costs about $160 per month on Namespace prepaid and about $430 on GitHub larger runners. Effect-TS/effect and oxc use Namespace, biome uses Depot, and pnpm uses Blacksmith. Those repositories run Rust builds or large type-check matrices where cores pay off. Here, the long single files (F3) don't get faster with more cores, and four parallel standard jobs are free. Reconsider after option 3, once worker counts are raised and the legs are CPU-bound.

## Organization

### Job split and parallelism

Every reference repository in the table below splits CI into parallel jobs. The one exception is remix-run/react-router's unit workflow, which runs build, typecheck, lint, and test in one job per Node version, the same shape as usine today ([test-unit.yml](https://github.com/remix-run/react-router/blob/386055e72ef59e0439998bc9952a403b34c300a7/.github/workflows/test-unit.yml)).

Splitting static checks into their own jobs (lint, format, knip, check) gains little here: together they take about 40 s, and they share one install. Keep them in one `static` job that runs in parallel with the test legs.

Group test legs by package, using turbo filters, not vitest shards. A package leg reuses turbo's per-package cache, so an unaffected leg finishes in about 40 s. Shard only inside the web leg, and in server if it is still the long pole after the file splits.

Use `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` so that pushes to `main` each get a full result. Turborepo, oxc, and pnpm do this.

### Required checks and the factory

There are no required checks today, and the factory relies on the rollup, not on branch protection. Add the aggregate `ci` job anyway, under the current job name `ci`. Its benefits:

- Anyone who links or filters on the `ci` check keeps working.
- Branch protection, if added later, requires one stable name, while matrix leg names can change.
- Path-filtered workflows such as `worker-image.yml` must never be required, because a workflow that its path filter skips leaves the check pending.

The rollup includes every check on the head, so the factory needs no change for the success case. Check the two unverified points under F9 before relying on the failure case while sibling legs still run.

### How other repositories do it

| Repository | Job split | Tests | Cache | Runners | Merge queue |
| --- | --- | --- | --- | --- | --- |
| [Effect-TS/effect](https://github.com/Effect-TS/effect/blob/39dce11faa868004b9cc96a9b3058bb8a2fb844b/.github/workflows/check.yml) | static checks, types matrix (3 legs), build, bundle, doctest; aggregate `Types` job | Matrix by runtime, `--max-concurrency=10`, no shards | `setup-node` pnpm cache, Namespace cache; no task cache | Namespace for types and tests | No |
| [Effect-TS/effect-smol](https://github.com/Effect-TS/effect-smol/blob/c2a5edc3abd31ad5bc123362bc1213e03e4095c3/.github/workflows/check.yml) | lint, types, build, docgen, circular as separate jobs | `shard: [1/2, 2/2]` × runtime | pnpm cache only | `ubuntu-latest` | No |
| [vercel/turborepo](https://github.com/vercel/turborepo/blob/3fbea718802a5d1e4ac7a4e8bad8f948a3439afe/.github/workflows/test-js-packages.yml) | One turbo call per OS × Node leg with `--affected`; aggregate jobs | Rust tests partitioned 2 ways | Turbo remote cache via OIDC | Larger 8-core runners for Rust | No |
| [vitejs/vite](https://github.com/vitejs/vite/blob/46b91c5bf9c2901b8511c893bc3fc38b8bba6e4f/.github/workflows/ci.yml) | `changed` gate, test matrix, lint job, pass and fail gates | Unit, serve, and build suites per leg | Playwright cache keyed by version | `ubuntu-latest`, `ubuntu-slim` gates | No |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest/blob/7fa169bae437da7e863e1b908bc7ab4e05020cda/.github/workflows/ci.yml) | lint job, test matrix by suite: "Split the heavy e2e and coverage suites onto their own runners" | Browser tests `--shard=1/2`, `2/2`; merge-reports job | Playwright cache by version, deps container | `ubuntu-latest` | No |
| [microsoft/typescript-go](https://github.com/microsoft/typescript-go/blob/f7c4664176a1ac8be4ba7b4981d0b17c0457a74c/.github/workflows/ci.yml) | build, test matrix, lint, format, generate, smoke; aggregate `required` | OS × config matrix, smaller under `merge_group` | None for JS | `ubuntu-latest`, XL pool for some legs | Yes |
| [oxc-project/oxc](https://github.com/oxc-project/oxc/blob/563cf449a94c6535c1583aa03a111b390b0e4f7e/.github/workflows/ci.yml) | About 25 small jobs, each path-gated | ARM and big-endian legs on `main` only | Saves cache on `main` only | Namespace, `ubuntu-24.04-arm` | Yes |
| [biomejs/biome](https://github.com/biomejs/biome/blob/109ab7f1b383cb261d13f5da7e294aee6f13831f/.github/workflows/pull_request.yml) | lint, deny, test, e2e, docs jobs; workflow path filter | cargo nextest | Rust cache based on `main` | Depot | Yes |
| [nrwl/nx](https://github.com/nrwl/nx/blob/1c3de4257b28926c2cf6cba9903c6bfa5445f053/.github/workflows/ci.yml) | One job that distributes to Nx Agents | `nx affected` from the last green `main` | Nx Cloud | `ubuntu-latest` plus agents | No |
| [pnpm/pnpm](https://github.com/pnpm/pnpm/blob/00f739e7678c2bdaeae424f4222156ecca5ee9c1/.github/workflows/ci.yml) | Compile once and share it as an artifact; test chunks; aggregate `Success` | Affected-only on PRs, full on root changes | Artifacts | Blacksmith | Yes |
| [sveltejs/kit](https://github.com/sveltejs/kit/blob/15aca36092e6e8ae6df6ab06a2965e3a11228d3a/.github/workflows/ci.yml) | lint, test matrix, e2e matrix (about 26 legs) | Playwright shards 1/2, 2/2 | pnpm cache, Playwright cache | `ubuntu-latest` | No |
| [remix-run/react-router](https://github.com/remix-run/react-router/blob/386055e72ef59e0439998bc9952a403b34c300a7/.github/workflows/test-unit.yml) | One serial job per Node (unit) | Integration per browser in a reusable workflow | `setup-node` pnpm cache | `ubuntu-latest` | No |
| [withastro/astro](https://github.com/withastro/astro/blob/cf27e70a9057ce29ade2a8a843bd9275a696e9ab/.github/workflows/ci.yml) | build, lint, test matrix, e2e, smoke | OS × Node × suite | Turbo remote cache; a [cleanup workflow](https://github.com/withastro/astro/blob/d94e841d5cbdf9c80e8625f6ec353f40996494bc/.github/workflows/cleanup-cache.yml) deletes PR caches | `ubuntu-latest` | Yes |

## Plan

Each step is sized as one pull request.

1. **Parallel CI.** Estimated median: 546 s → about 220 s on pull requests, about 230 s on `main`.
   - Rewrite `ci.yml` into `static`, a four-leg `test` matrix filtered by package, and an aggregate `ci` gate.
   - Restore the turbo cache on every run, and save it only on `main`, per leg.
   - Exclude tests from `build` inputs (option 2).
   - Cancel in progress only on pull requests.
   - Move the latency test to a main-only job (option 4).
   - Delete the existing `turbo-Linux-ci-node22-*` entries once, through the cache API or `gh cache delete`, to get back under 10 GB.
   - Verify with `--dry=json` that a test-only engine edit changes 2 hashes.
   - After the merge, read the per-leg step timings from the first ten pull request runs and compare them with this document's table.
2. **Long poles.** Estimated: about 220 s → 150–180 s, with the web or server leg as the remaining critical path.
   - Split the four long server and executor files.
   - Set `maxWorkers` for the web suite from `VITEST_MAX_WORKERS`, which `turbo.json:22` already passes through, and raise it in the web leg.
   - Shard the web leg two ways if it is still the long pole.
   - Set `silent: 'passed-only'` in the noisy packages.
   - Key the Playwright cache by version.
3. **Remote cache.** Optional; it needs the owner's choice of provider and of the write policy for pull requests. Estimated: −20 to −35 s per leg, cache-limit evictions stop, and pull request reruns stay warm.
   - Add a turbo remote cache, Vercel or self-hosted, and remove the `.turbo` Actions cache.
   - Hash the Node major into turbo (option 6), so that pull request results come from Node 22 runs.

## Unverified claims

- **Rollup state with a failed and a running job.** GitHub's documentation for `statusCheckRollup` wasn't checked for whether `state` reports `FAILURE` while another check is still pending, or stays `PENDING` until all complete. The answer decides whether the factory starts a fix run before the slowest leg ends.
- **Log archive timing.** The factory downloads the run-attempt log archive (`actions/runs/{id}/attempts/{n}/logs`) for a failed check. Whether that archive is available while sibling jobs of the same run still run wasn't checked. If it isn't, the code falls back to the check output text (`checks.ts`, the `catchIf` branch), which loses the failed-step excerpt. The per-job endpoint `actions/jobs/{job_id}/logs` would avoid the question.
- **Projected leg durations.** All gains for options 1–3 are estimates from serial-run medians. Contention inside a leg, and browser tests at 3 workers on 4 CPUs, weren't measured.
- **Worker precedence.** Whether `VITEST_MAX_WORKERS` overrides an explicit `maxWorkers` in the config wasn't checked.
- **Compile-only builds.** Whether TypeScript 7's `tsc -b` supports skipping type checks (`--noCheck`) for project builds wasn't checked.
- **`optimizeDeps.force`.** The cost of `optimizeDeps: { force: true }` in the browser project wasn't measured.
- **Main's empty cache.** The cause of main's empty turbo cache at 2026-11-03 16:04, eviction or a manual deletion, is inferred, not confirmed.
- **Repository visibility in October.** Whether the repository was private when #517 counted minutes against the included 2,000 wasn't checked.
- **Vendor pricing.** Merge-queue availability wording (org-owned public repositories) came from search snippets. Blacksmith per-size prices are inferred as linear in vCPU, and Namespace's ARM price isn't listed. GitHub's cache retention maximums and its price above 10 GB came from search summaries.
- **Vitest docs.** The `--since-last-run` affected-tests recipe in the vitest docs was read only through a search summary. The vitest docs say the default `maxWorkers` "uses all available parallelism"; the installed 5.0.5 source uses `availableParallelism() - 1`, and this document relies on the source.

## Not measured

- Local suite runs. This document uses CI logs instead: per-file timings across seven full runs on the real runner. Local macOS timings would not transfer, and some server and Cloudflare tests need Linux tools (`setsid`, `flock`, `stat -c`).
- `turbo run test` at a concurrency above 1 on the CI runner.
- How often pull requests change only test files in a shared package, which sets option 2's real-world gain.
- Per-test CPU profiles of the long-pole files, to find avoidable waits as opposed to real process work.

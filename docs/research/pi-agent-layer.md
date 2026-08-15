# Pi as the agent layer: can it drive full dev runs?

Resolves [basaltbytes/usine#4](https://github.com/basaltbytes/usine/issues/4).
Researched 2026-08-15 against primary sources only:

- npm `@earendil-works/pi-coding-agent` **0.84.2** (published 2026-08-14),
  installed locally and read from source (`docs/`, `dist/`, `package.json`,
  `CHANGELOG.md`, `npm-shrinkwrap.json`). Paths below of the form
  `pi:<path>` are inside that installed package.
- GitHub `earendil-works/pi` (formerly `badlogic/pi-mono`): MIT, 90 653 stars,
  latest release v0.84.2 (2026-08-14), pushed 2026-08-15 (`gh api
  repos/earendil-works/pi`, checked 2026-08-15).
- [pi.dev](https://pi.dev) — the project site: docs, install instructions, and
  a package registry for extensions/skills/themes. **It is not a hosted or
  cloud service**; there is no Pi cloud to hand runs to (fetched 2026-08-15).
- Balade's verified notes at
  `balade:docs/research/pi-coding-agent-sdk.md` (their 0.83.0 audit, rechecked
  against repo main on 2026-08-03) and balade's adapter `balade:src/pi/*`
  (paths of the form `balade:<path>` are relative to
  `/Users/philippelattention/Code/balade`).

Claims below are **verified in source** unless marked *(docs claim)*.

## TL;DR

Yes. Pi's *default* tool set is `read`, `bash`, `edit`, `write` — full dev
capability out of the box; balade's read-only posture was a deliberate
restriction it built on top, not a Pi limit. Pi is not a wrapper that drives
Claude Code or Codex CLI — it is its own complete harness (agent loop + tools
+ sessions) that talks to provider APIs directly through `pi-ai`, so
"Pi drives the other agents" resolves to "Pi *replaces* the other agents":
one SDK, one event stream, one session format, any provider. It is headless-
friendly (SDK in-process, print/JSON mode, JSON-RPC subprocess mode) and
container-ready, but it ships **no sandbox and no permission prompts** — the
isolation boundary is yours to provide — and it is a fast-moving 0.x with
routine breaking changes, so usine must pin exactly and treat upgrades as
maintenance work.

## 1. Can Pi write, execute, and commit?

**Verified: yes, by default.**

- The package describes itself as a "Coding agent CLI with read, bash, edit,
  write tools and session management" (`pi:package.json` `description`).
- Built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`;
  the **default** enabled set is `read`, `bash`, `edit`, `write`
  (`pi:docs/sdk.md` "Tools"; factories in `pi:dist/core/tools/index.js` —
  `allToolNames`, `createCodingTools(cwd)` returns read+bash+edit+write).
- `bash` executes arbitrary shell commands with the process's permissions —
  schema is just `{ command, timeout }` (`pi:dist/core/tools/bash.d.ts`).
  Tests, builds, `git add`/`git commit`/`git push`, `gh pr create` are all
  ordinary bash invocations; there is no separate git tool and none is needed.
- `write` and `edit` mutate files, serialized per-path through a mutation
  queue (`pi:dist/core/tools/write.js:147-163`,
  `pi:dist/core/tools/edit.js:182-214`). The `edit` tool returns
  `details.patch` as a standard unified patch for SDK consumers
  (`pi:docs/sdk.md` "Tools") — useful for usine's audit trail.
- Pi's own docs state the model plainly: "Pi runs with all permissions by
  default" (`pi:docs/containerization.md:3`); "Built-in tools can read files,
  write files, edit files, and run shell commands with the permissions of the
  pi process. … Pi does not include a built-in sandbox"
  (`pi:docs/security.md` "No Built-in Sandbox").

Balade's read-only setup confirms the flip side: it passed a `tools:`
allowlist of seven custom read-only tools and never enabled `bash`, `edit`,
or `write` (`balade:src/pi/session.ts:322-354`). Usine simply keeps the
default coding set instead.

## 2. Across providers?

**Verified.** Pi does not shell out to Claude Code or Codex CLI. Its model
layer `@earendil-works/pi-ai` depends directly on the official provider SDKs —
`@anthropic-ai/sdk`, `openai`, `@google/genai`,
`@aws-sdk/client-bedrock-runtime` (`pi-ai 0.84.2 package.json`
`dependencies`) — and the same agent loop and tools run against any model in
the catalog, switchable mid-session (`pi:docs/sdk.md` "Model";
`AgentSession.setModel()`).

Auth options relevant to usine (`pi:docs/providers.md`):

- **API keys** (env vars or `auth.json`): Anthropic, OpenAI, Google, Bedrock,
  Mistral, Groq, xAI, and more — the clean path for headless automation.
- **Subscription OAuth**: ChatGPT Plus/Pro (Codex) — *(docs claim)*
  "officially endorsed by OpenAI" via the
  [Codex for OSS](https://developers.openai.com/community/codex-for-oss)
  program; Claude Pro/Max — but Anthropic bills third-party-harness usage as
  per-token "extra usage", **not** against plan limits
  (`pi:docs/providers.md` "Claude Pro/Max"; balade's notes trace this to
  Anthropic's Feb 2026 policy change,
  `balade:docs/research/pi-coding-agent-sdk.md` §1). So subscription login
  works headlessly (manual-code fallback exists) but is not a way to ride
  plan allowances for Anthropic.
- Credentials live in `~/.pi/agent/auth.json` (0600, file-locked), and the
  embedding app can redirect storage entirely via
  `ModelRuntime.create({ authPath, modelsPath })` — balade isolates its own
  agent dir this way (`balade:src/pi/client.ts:95-113`). Usine should do the
  same so orchestrator runs never touch a user's `~/.pi/agent`.

## 3. Workspace model

**Verified.** The workspace is a plain directory handed to the session:
`createAgentSession({ cwd })` builds every built-in tool scoped to that cwd
(`pi:docs/sdk.md` "Tools with Custom cwd"). Two properties matter for usine:

- **cwd is a default, not a boundary.** Tool paths "relative or absolute"
  resolve via `resolveToCwd`, which honors absolute paths and `~` expansion
  with no confinement check (`pi:dist/core/tools/path-utils.js`
  `resolveToCwd`; `pi:dist/core/tools/write.js:13`). Bash inherits full
  process permissions. Pi is explicit that project trust "is not a sandbox"
  and real isolation "needs to come from the operating system or a
  virtualization/container boundary" (`pi:docs/security.md`).
- **Everything else is injectable per session**: `sessionManager`
  (in-memory or file-backed JSONL session trees with resume/fork/branch —
  `pi:docs/sdk.md` "Session Management"), `settingsManager`
  (`SettingsManager.inMemory()` — used by balade to disable compaction and
  retry, `balade:src/pi/session.ts:350-353`), `resourceLoader` (full control
  of system prompt, skills, extensions, context files —
  `balade:src/pi/session.ts:503-525` shows a minimal one), and `modelRuntime`.
  Nothing forces global state into a run.

So usine's worker seam maps cleanly: one git worktree/clone per matched item →
one `createAgentSession({ cwd: worktree, … })` → `prompt()` → stream events →
collect commits. Sessions are single-writer JSONL files
(`pi:docs/session-format.md`), resumable via
`SessionManager.open(file)` / `AgentSessionRuntime.switchSession/fork` —
which gives usine durable, replayable run transcripts and a resume story for
multi-turn loops (review → act on findings) for free.

Concurrency: multiple sessions with different cwds in one process are
supported (each tool set closes over its own cwd), but tool bash inherits
`process.env` — per-run env injection goes through `BashToolOptions.spawnHook`
/ `env` (`pi:dist/core/tools/bash.d.ts`). Balade hit one true global:
`RIPGREP_CONFIG_PATH` is process-wide with no per-session seam
(`balade:src/pi/session.ts:551-557`) — a reminder that Pi assumes
one-agent-per-process in places; usine's worker-per-process model sidesteps
this class of issue entirely.

## 4. Headless / cloud story

**Verified.** Four run modes (`pi:README.md`): interactive TUI, print/JSON,
RPC, SDK.

- **SDK in-process** — what balade uses; full type-safe control
  (`pi:docs/sdk.md`).
- **Print mode** `pi -p "…"` / `--mode json`: one-shot, streams every session
  event as JSON lines (`pi:docs/json.md`, `pi:docs/usage.md:173-175`).
- **RPC mode** `pi --mode rpc`: newline-delimited JSON-RPC over stdio —
  prompt/steer/abort/get_state/set_model/fork and more (`pi:docs/rpc.md`) —
  the process-isolation seam if usine ever wants agent crashes out of the
  orchestrator process. The previously-unpublished `pi-client`/`pi-protocol`
  workspace packages are published dependencies as of 0.84.x
  (`pi:package.json` `dependencies`), so a typed client exists.
- **Non-interactive trust**: `-p`/`--mode json`/`--mode rpc` never show a
  trust prompt; untrusted project resources are skipped under the default
  policy, overridable per run with `--approve` (`pi:docs/security.md`
  "Project Trust"). Good default for running strangers' PRs.
- **Containers, not cloud**: pi.dev hosts docs and a package registry, not
  compute. The supported isolation patterns are documented in
  `pi:docs/containerization.md`: whole-process Docker, a Gondolin micro-VM
  extension that reroutes the built-in tools' execution into a VM, or an
  OpenShell policy sandbox. This matches usine's local-first-movable-to-cloud
  shape: usine owns the box; Pi runs wherever usine puts it.
- **Emerging remote-execution seam**: 0.84.x adds a backend-independent
  `ExecutionEnv` (capability-style `FileSystem` + `Shell`, `Result`-typed
  errors, `NodeExecutionEnv` as the local backend) in
  `@earendil-works/pi-agent-core` (`pi-agent-core:dist/harness/types.d.ts`),
  consumed by `createCodingAgentHarness({ env, … })`
  (`pi:dist/server/create-harness.d.ts`), plus `BashOperations` explicitly
  documented as "Override these to delegate command execution to remote
  systems (for example SSH)" (`pi:dist/core/tools/bash.d.ts`). If usine later
  wants tool execution inside a container while the loop runs in the
  orchestrator, the seam exists — but it is brand new surface; treat it as
  unstable.

## 5. Stability

**Verified — active and honest about churn.**

- 0.x with routine, documented breaking changes: 41 releases in ~14 weeks
  (0.74.0 on 2026-05-07 → 0.84.2 on 2026-08-14, npm `time` data) — roughly
  one every 2–3 days. Since balade's 0.83.0 pin alone: 0.84.0, 0.84.1, 0.84.2 in two weeks, and
  **0.84.0's Breaking Changes hit exactly the surfaces an orchestrator
  consumes**: JSON/RPC `message_update` events became delta-only (clients
  must assemble partials themselves), `ModelRegistry.getApiKeyAndHeaders()`
  and `ModelRuntime.setRuntimeApiKey()` signatures changed
  (`pi:CHANGELOG.md` `## [0.84.0]`).
- No published semver-stability promise for the SDK surface (balade's audit,
  `balade:docs/research/pi-coding-agent-sdk.md` §4, still true at 0.84.2).
- Mitigations that work (proven by balade): pin the exact version (balade:
  `"@earendil-works/pi-coding-agent": "0.83.0"`, `balade:package.json:59-60`);
  the package ships an `npm-shrinkwrap.json` pinning its full transitive tree
  (`pi:package.json` `files`); rich injectable test seams (faux provider,
  in-memory stores) let an adapter's contract tests catch breakage on upgrade
  (`balade:docs/research/pi-coding-agent-sdk.md` §5).
- Constraints to inherit: ESM-only, Node >= 22.19.0 declared, effectively
  `^22.22.2 || ^24.15.0 || >=26.0.0` per balade's audit
  (`balade:package.json:104`); importing the root barrel loads TUI modules
  (no TUI-free subpath as of 0.83.0 — balade audit §5; the 0.84.2 export map
  still has only `.`, `./rpc-entry`, `./client`, `pi:package.json`).
- Project health: MIT, 90.6k stars, pushed daily, single dominant author
  (Mario Zechner / earendil-works) — high bus-factor risk priced against very
  high velocity.

## What this means for usine

**Pi-drives-all holds for full dev runs — with eyes open.** The v1 acceptance
loops (issue → PR, review a PR, act on findings) need write + exec + commit,
and that is Pi's *default* configuration, not an extension: keep
`tools: ["read", "bash", "edit", "write"]` (or just the defaults), point
`cwd` at a per-item worktree, and commits are bash. Nothing about balade's
read-only allowlist was a Pi ceiling — it was policy, expressed through the
same `tools:`/`customTools:` seam usine will use to express *its* policy.

**The framing correction: Pi doesn't drive the other agents — it replaces
them.** There is no Claude Code or Codex CLI underneath; `pi-ai` speaks the
provider APIs directly. So the real choice is "Pi's harness against provider
APIs" vs "per-agent adapters around Claude Code / Codex CLI", and Pi wins on
every axis usine cares about: one SDK/event stream/session format instead of
N CLI contracts, in-process embedding with typed events
(`tool_execution_start/end`, `agent_end`, usage/cost stats), injectable
everything (auth path, sessions, settings, system prompt), and provider
switching as a parameter rather than an adapter swap. The cost is that usine
gives up whatever is proprietary to those CLIs (Claude Code's permission
prompts, sandboxing, subagents; Codex CLI's cloud handoff) — and for
Anthropic, subscription-plan economics: through any third-party harness,
Claude Pro/Max usage is per-token "extra usage". Usine should assume API-key
billing.

**Permission model: there isn't one — usine must be the permission model.**
Pi has no approval prompts, no sandbox, and cwd is not a boundary
(`resolveToCwd` honors absolute paths; bash is unrestricted). For unattended
loop runs on many repos, that means: (1) isolate at the OS level —
per-run worktrees at minimum, containers (Pi's own documented Docker pattern)
for anything untrusted; (2) express soft policy in-process via the extension
`tool_call` event, which fires before execution and can veto with
`{ block: true, reason, terminate }` (`pi:docs/extensions.md` "tool_call") —
the right seam for usine guardrails like "no pushes to main" or command
denylists, understood as a tripwire, not a boundary; (3) scope credentials —
per-run `authPath`, minimal env into bash via `spawnHook`.

**Worker seam:** one session per matched item — `createAgentSession({ cwd:
worktree, model, modelRuntime, sessionManager:
SessionManager.create(worktree), settingsManager, resourceLoader })`,
`prompt()` per loop turn, subscribe for progress, `getSessionStats()` for
cost, JSONL session file as the durable run transcript, `open`/`fork` for
resume. Balade's adapter (`balade:src/pi/client.ts`, `session.ts`) is a
working reference for the lifecycle (acquire/release, abort-with-timeout,
error taxonomy mapping) — usine's version is the same shape minus the
read-only straitjacket.

**What would force per-agent adapters instead:** (a) a hard requirement for
plan-included Anthropic subscription usage — only Claude Code gets that;
(b) needing a vendor CLI's proprietary features (Claude Code sandboxing/
subagents, Codex cloud tasks) rather than reproducing them; (c) Pi's churn
becoming unaffordable — a 0.x that breaks its JSON/RPC event wire format in a
minor release will do it again, so if pinned-version upgrades with contract
tests are more maintenance than usine will carry, wrapping stable vendor CLIs
is the fallback; (d) the single-maintainer project stalling. None of these
holds today. Recommendation: adopt Pi as the single agent layer, pin exact
versions behind one usine-owned adapter module (usine's own `AgentRun` seam,
as balade did with `WalkthroughAuthor`), keep contract tests on the faux
provider, and treat Pi upgrades as scheduled maintenance.

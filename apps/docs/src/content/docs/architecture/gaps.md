---
title: "Gaps"
description: "What the code doesn't do yet, grouped by area, with the open issue for each gap."
sidebar:
  order: 7
---

:::note
This page describes commit [`7c0c3d3`](https://github.com/basaltbytes/usine/tree/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9) of basaltbytes/usine and its open issues as they were on 2026-10-16.
:::

What the code doesn't do yet, or does badly, grouped by area. The issue numbers come from `gh issue list --repo basaltbytes/usine --state open --limit 200` on 2026-10-16; 63 issues were open, and each gap below links to one of them.

## Onboarding, distribution, CLI

- [#41][]: there is no `create-usine` scaffolder, no GitHub App manifest flow, and no Workers page with preflight on demand; without credentials `usine up` only shows a notice ([up.ts:122][]).
- [#154][]: the CLI has `up`, `backup`, and `export-run` only, with no `status`, `stop`, `restart`, or `upgrade` ([cli.ts:23][]).
- [#233][]: npm installs of usine packages pull `@effect/platform-node-shared` 4.0.4, which needs `effect` ^4.0.4.

## Configuration

- [#40][]: the UI has no configuration form or raw editor, and the surgical YAML writer has no production caller ([writer.ts][]).
- [#331][]: a reload refuses any change to `workers` or `webhooks`, so changing a Worker's `max_concurrent_attempts` still needs a restart.
- [#332][]: a reload doesn't preflight the harness of a new or changed Agent; its first Attempt fails with `AgentFailure` instead.

## Triggers and polling

- [#37][]: usine parses `webhooks.mode` but never reads it, there is no `POST /webhooks/github`, and Board moves are the only Hint source ([operator.ts:556][]).
- [#158][]: every poll fetches every known open pull request again, instead of only after the base branch changes ([polling.ts:222][]).
- [#152][]: the Run drawer can't rerun a completed Run whose outcome left the Item unresolved.
- [#333][]: after a reload, new Loops apply only when the current poll wait ends, up to one `poll_interval` later.

## Asks and notifications

- [#36][]: usine posts no Ask on GitHub; approvals, failures, and cycle-budget Asks are visible in the UI only, and there is no question tool that pauses an Attempt.

## Cost accounting

- [#35][]: Attempt rows have no usage summary and the UI has no Usage page; token counts and rate windows exist only as transcript envelopes ([schema.ts:169][]).
- [#248][]: usage of Claude Code children paid by the Gateway's API key is reported under the Claude plan pool.

## Run engine and recovery

- [#159][]: an operator message to a Pi parent that is waiting on a child waits for the child, then ends the Attempt as `Succeeded`.
- [#177][]: a reattached Attempt keeps its own Worker while the scheduler reserved a slot on another one ([store.ts:284][]).
- [#178][]: the runaway guard loses an Attempt's elapsed time and its finished sessions' tokens across a reattach.
- [#180][]: the checkout of an Attempt closed between a restart and its reattach isn't reconciled until the next startup.

## Durable layer

- [#179][]: usine detects a poisoned pi-durable session by wrapping storage and matching an error message.
- [#181][]: a Pi child's grep and find tools inherit the orchestrator's environment.
- [#182][]: the durable Pi parent runs without Pi's HTTP dispatcher settings.
- [#185][]: the durable Pi parent's system prompt is only the usine section.
- [#187][]: a crash between an append and the progress commit can lose one envelope that isn't derived from a parent entry.
- [#195][]: a task that finishes at the moment its relay fails stays live after `stopTask` cancels it.
- [#217][]: `DurableHarness` must handle pi-durable's `SessionFailed` before upgrading past 1.1.0.

## Harnesses

- [#227][]: pull request harvest logs a warning whenever an Attempt's final commit was never pushed.
- [#258][]: the Codex app-server requests github.com and api.github.com on a Worker behind the Gateway.
- [#266][]: a Codex child that can't connect to its provider reconnects silently for as long as the Attempt runs.
- [#277][]: `StepResult` allows a `Comment` fact, but `harvestFacts` never records one ([harvest.ts:135][]).

## Workers

See [Workers and the Gateway](/architecture/workers-and-gateway/) for how each Worker kind works.

- [#223][]: the umbrella issue for replacing exe.dev with EU Workers that usine controls, in three stages.
- [#228][]: `usine up` refuses `exe.dev` Workers and mixed Worker kinds ([worker-engine.ts:13][], [scheduler.ts:76][]).
- [#196][]: exe.dev Workers can't run Pi children.
- [#199][]: canceling an unlaunched live Attempt on exe.dev leaves its remote children running.
- [#200][]: exe.dev recovery no longer stops a run host left by an earlier usine version.
- [#201][]: the exe.dev Worker with SSH children hasn't run on a real VM.
- [#230][]: the tests haven't run an SSH Worker with real Claude Code and Codex children.
- [#231][]: Attempts on one SSH Worker without a Gateway can read each other's GitHub token.
- [#229][]: the harness versions pinned in `infra/hetzner/cloud-init.yaml` must be updated by hand to match the versions usine supports.
- [#257][]: the live SSH preflight test cases don't show each harness's outcome.
- [#270][]: two Attempts at once thrash a 4 GB Worker until sshd stops responding.
- [#278][]: local and direct SSH preflight don't check the GitHub credential; only the exe.dev preflight raises the `credentials` capability ([exe-dev/preflight.ts:123][]).

## Gateway

- [#234][]: the Gateway's use of a Claude subscription token hasn't been tested against Anthropic.
- [#235][]: the Gateway can't store a Codex ChatGPT login with token refresh.
- [#236][]: reloading the egress allowlist or the secrets drops the in-memory attachments.
- [#237][]: the Gateway doesn't serve GitHub release download URLs or follow repository rename redirects.
- [#240][]: a tunnel opened to an allowed name can be reused for other names on the same certificate (HTTP/2 coalescing, domain fronting).
- [#243][]: Attempts on one machine behind the Gateway can read each other's caller tokens.
- [#249][]: the executor doesn't open or maintain the SSH forward to a Gateway's admin API; the operator must do it.
- [#254][]: Workers behind the Gateway have no time source.
- [#255][]: a tunnel that the client closes before its ClientHello is logged as a `not-tls` refusal.
- [#261][]: harness turns behind the Gateway request hosts outside the egress allowlist.
- [#262][]: `usine-gateway` exits with status 130 when systemd stops it.
- [#264][]: infrastructure changes are applied to a running Gateway only by hand, and never to a running Worker.

## Agent behaviour in the dogfood Loops

See [The dogfood instance's Loops](/architecture/loops-shipped/) for the Loop files.

- [#226][]: the reviewer Agent pushed a fix commit to a pull request branch although `review-pr` forbids branch edits.
- [#241][]: `act-on-findings` repeats an Attempt that ended with an operator question until the cycle budget is used up.
- [#242][]: a `finish-pr` commit on the local Worker has the operator as its author instead of the factory's App.

## Observability

- [#279][]: `apps/server` installs no tracer, so the `Effect.fn` spans aren't exported anywhere, and only console logs are available.

## Later and other

- [#115][]: v2 task-source port, with local Markdown files as the first source besides GitHub.
- [#56][]: a seed issue used by tests; it is not a gap.

[up.ts:122]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/up.ts#L122
[cli.ts:23]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/cli.ts#L23
[writer.ts]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/config/src/yaml/writer.ts
[operator.ts:556]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/operator/operator.ts#L556
[polling.ts:222]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/polling/polling.ts#L222
[store.ts:284]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/engine/src/store/store.ts#L284
[schema.ts:169]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/engine/src/database/schema.ts#L169
[harvest.ts:135]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/core/src/step/harvest.ts#L135
[worker-engine.ts:13]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/worker-engine.ts#L13
[scheduler.ts:76]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/orchestrator/src/scheduler.ts#L76
[exe-dev/preflight.ts:123]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/packages/executor/src/exe-dev/preflight.ts#L123
[#35]: https://github.com/basaltbytes/usine/issues/35
[#36]: https://github.com/basaltbytes/usine/issues/36
[#37]: https://github.com/basaltbytes/usine/issues/37
[#40]: https://github.com/basaltbytes/usine/issues/40
[#41]: https://github.com/basaltbytes/usine/issues/41
[#56]: https://github.com/basaltbytes/usine/issues/56
[#115]: https://github.com/basaltbytes/usine/issues/115
[#152]: https://github.com/basaltbytes/usine/issues/152
[#154]: https://github.com/basaltbytes/usine/issues/154
[#158]: https://github.com/basaltbytes/usine/issues/158
[#159]: https://github.com/basaltbytes/usine/issues/159
[#177]: https://github.com/basaltbytes/usine/issues/177
[#178]: https://github.com/basaltbytes/usine/issues/178
[#179]: https://github.com/basaltbytes/usine/issues/179
[#180]: https://github.com/basaltbytes/usine/issues/180
[#181]: https://github.com/basaltbytes/usine/issues/181
[#182]: https://github.com/basaltbytes/usine/issues/182
[#185]: https://github.com/basaltbytes/usine/issues/185
[#187]: https://github.com/basaltbytes/usine/issues/187
[#195]: https://github.com/basaltbytes/usine/issues/195
[#196]: https://github.com/basaltbytes/usine/issues/196
[#199]: https://github.com/basaltbytes/usine/issues/199
[#200]: https://github.com/basaltbytes/usine/issues/200
[#201]: https://github.com/basaltbytes/usine/issues/201
[#217]: https://github.com/basaltbytes/usine/issues/217
[#223]: https://github.com/basaltbytes/usine/issues/223
[#226]: https://github.com/basaltbytes/usine/issues/226
[#227]: https://github.com/basaltbytes/usine/issues/227
[#228]: https://github.com/basaltbytes/usine/issues/228
[#229]: https://github.com/basaltbytes/usine/issues/229
[#230]: https://github.com/basaltbytes/usine/issues/230
[#231]: https://github.com/basaltbytes/usine/issues/231
[#233]: https://github.com/basaltbytes/usine/issues/233
[#234]: https://github.com/basaltbytes/usine/issues/234
[#235]: https://github.com/basaltbytes/usine/issues/235
[#236]: https://github.com/basaltbytes/usine/issues/236
[#237]: https://github.com/basaltbytes/usine/issues/237
[#240]: https://github.com/basaltbytes/usine/issues/240
[#241]: https://github.com/basaltbytes/usine/issues/241
[#242]: https://github.com/basaltbytes/usine/issues/242
[#243]: https://github.com/basaltbytes/usine/issues/243
[#248]: https://github.com/basaltbytes/usine/issues/248
[#249]: https://github.com/basaltbytes/usine/issues/249
[#254]: https://github.com/basaltbytes/usine/issues/254
[#255]: https://github.com/basaltbytes/usine/issues/255
[#257]: https://github.com/basaltbytes/usine/issues/257
[#258]: https://github.com/basaltbytes/usine/issues/258
[#261]: https://github.com/basaltbytes/usine/issues/261
[#262]: https://github.com/basaltbytes/usine/issues/262
[#264]: https://github.com/basaltbytes/usine/issues/264
[#266]: https://github.com/basaltbytes/usine/issues/266
[#270]: https://github.com/basaltbytes/usine/issues/270
[#277]: https://github.com/basaltbytes/usine/issues/277
[#278]: https://github.com/basaltbytes/usine/issues/278
[#279]: https://github.com/basaltbytes/usine/issues/279
[#331]: https://github.com/basaltbytes/usine/issues/331
[#332]: https://github.com/basaltbytes/usine/issues/332
[#333]: https://github.com/basaltbytes/usine/issues/333

---
title: "Gaps"
description: "What the code doesn't do yet, grouped by area, with the open issue for each gap."
sidebar:
  order: 7
---

:::note
This page describes commit [`7c0c3d3`](https://github.com/basaltbytes/usine/tree/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9) of basaltbytes/usine and its open issues as they were on 2026-10-16.
:::

Open issues from `gh issue list --repo basaltbytes/usine --state open --limit 200` on 2026-10-16 (63 issues).

## CLI and configuration

- [#41][]: no `create-usine` scaffolder, GitHub App manifest flow, or preflight on demand. Without credentials, `usine up` only shows a notice ([up.ts:122][]).
- [#40][]: the Configuration section is read-only; the YAML writer has no production caller.

## Triggers, asks, and cost

- [#37][]: `webhooks.mode` is unused, there is no `POST /webhooks/github`, and board moves are the only hint source.
- [#36][]: usine posts no ask on GitHub: approvals, failures, and cycle-budget asks are UI-only. No question tool pauses an attempt.
- [#35][]: no per-attempt usage summary or usage page; token counts and rate windows exist only as transcript envelopes.

## Run engine and durable layer

- [#182][]: the durable Pi parent runs without Pi's HTTP dispatcher settings.
- [#185][]: the durable Pi parent's system prompt is only the usine section.
- [#187][]: a crash between an append and the progress commit can lose one envelope without a parent entry.
- [#195][]: a task that finishes as its relay fails stays live after `stopTask` cancels it.

## Harnesses and workers

- [#258][]: behind the gateway, the Codex app-server requests github.com and api.github.com.
- [#223][]: umbrella issue: replace exe.dev with EU workers that usine controls, in three stages.
- [#228][]: `usine up` refuses `exe.dev` workers and mixed worker kinds ([Workers and the gateway](/architecture/workers-and-gateway/)).
- [#196][]: exe.dev workers can't run Pi children.
- [#199][]: canceling an unlaunched live attempt on exe.dev leaves remote children running.
- [#200][]: exe.dev recovery no longer stops a run host from older usine versions.
- [#201][]: the exe.dev worker with SSH children is untested on a real VM.
- [#230][]: SSH workers are untested with real Claude Code and Codex children.
- [#231][]: attempts on one SSH worker without a gateway can read each other's GitHub token.

## Gateway

- [#234][]: Claude subscription tokens through the gateway are untested against Anthropic.
- [#235][]: the gateway can't store a Codex ChatGPT login with token refresh.
- [#240][]: a tunnel to an allowed name can serve other names on the same certificate (HTTP/2 coalescing, domain fronting).
- [#243][]: attempts on one machine behind the gateway can read each other's caller tokens.
- [#261][]: harness turns behind the gateway request hosts outside the egress allowlist.
- [#264][]: infrastructure changes apply to running gateways only by hand, and never to running workers.

## Other

- [#115][]: v2 task-source port, with local Markdown files as the first non-GitHub source.
- [#56][]: a seed issue for tests, not a gap.

[up.ts:122]: https://github.com/basaltbytes/usine/blob/7c0c3d3696123d11e3d5b9cc3d27e18bb21e84e9/apps/server/src/up.ts#L122
[#35]: https://github.com/basaltbytes/usine/issues/35
[#36]: https://github.com/basaltbytes/usine/issues/36
[#37]: https://github.com/basaltbytes/usine/issues/37
[#40]: https://github.com/basaltbytes/usine/issues/40
[#41]: https://github.com/basaltbytes/usine/issues/41
[#56]: https://github.com/basaltbytes/usine/issues/56
[#115]: https://github.com/basaltbytes/usine/issues/115
[#182]: https://github.com/basaltbytes/usine/issues/182
[#185]: https://github.com/basaltbytes/usine/issues/185
[#187]: https://github.com/basaltbytes/usine/issues/187
[#195]: https://github.com/basaltbytes/usine/issues/195
[#196]: https://github.com/basaltbytes/usine/issues/196
[#199]: https://github.com/basaltbytes/usine/issues/199
[#200]: https://github.com/basaltbytes/usine/issues/200
[#201]: https://github.com/basaltbytes/usine/issues/201
[#223]: https://github.com/basaltbytes/usine/issues/223
[#228]: https://github.com/basaltbytes/usine/issues/228
[#230]: https://github.com/basaltbytes/usine/issues/230
[#231]: https://github.com/basaltbytes/usine/issues/231
[#234]: https://github.com/basaltbytes/usine/issues/234
[#235]: https://github.com/basaltbytes/usine/issues/235
[#240]: https://github.com/basaltbytes/usine/issues/240
[#243]: https://github.com/basaltbytes/usine/issues/243
[#258]: https://github.com/basaltbytes/usine/issues/258
[#261]: https://github.com/basaltbytes/usine/issues/261
[#264]: https://github.com/basaltbytes/usine/issues/264

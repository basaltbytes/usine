This page describes commit `c56246f` of basaltbytes/usine and its open issues as they were on 2026-10-16.

# Gaps

What the code does not do yet, or does badly, grouped by area. The issue numbers come from `gh issue list --repo basaltbytes/usine --state open --limit 200` on 2026-10-16; 58 issues were open. A line marked "no open issue found" is a gap seen in the code that no open issue title describes.

## Onboarding, distribution, CLI

- #41: there is no `create-usine` scaffolder, no GitHub App manifest flow, and no Workers page with preflight on demand; without credentials `usine up` only shows a notice (`apps/server/src/up.ts:122`).
- #154: the CLI has `up`, `backup`, and `export-run` only, with no `status`, `stop`, `restart`, or `upgrade` (`apps/server/src/cli.ts:23`).
- #233: npm installs of usine packages pull `@effect/platform-node-shared` 4.0.4, which needs `effect` ^4.0.4.
- No open issue found: the instance is read once at startup and nothing watches it, so every configuration edit needs a restart (`apps/server/src/up.ts:114`).

## Configuration editing

- #40: the UI has no configuration form or raw editor, and the surgical YAML writer has no production caller (`packages/config/src/yaml/writer.ts`).

## Triggers and polling

- #37: `webhooks.mode` is parsed and never read, there is no `POST /webhooks/github`, and Board moves are the only Hint source (`packages/orchestrator/src/operator/operator.ts:556`).
- #158: every poll fetches every known open pull request again, instead of only after the base branch moves (`packages/orchestrator/src/polling/polling.ts:222`).
- #267: a canceled Run keeps its Event, so relabeling an Item back to the same content opens nothing (`packages/engine/src/store/store.ts:117`).
- #152: the Run drawer cannot run again a completed Run whose outcome left the Item unresolved.

## Asks and notifications

- #36: no Ask is posted on GitHub; approvals, failures, and cycle-budget Asks are visible in the UI only, and there is no question tool that parks an Attempt.

## Cost accounting

- #35: Attempt rows have no usage summary and the UI has no Usage page; token counts and rate windows exist only as transcript envelopes (`packages/engine/src/database/schema.ts:169`).
- #248: usage of Claude Code children paid by the Gateway's API key is reported under the Claude plan pool.

## Run engine and recovery

- #159: an operator message to a Pi parent that is waiting on a child waits for the child, then ends the Attempt as `Succeeded`.
- #177: a reattached Attempt keeps its own Worker while the scheduler reserved a slot on another one (`packages/engine/src/store/store.ts:284`).
- #178: the runaway guard forgets an Attempt's elapsed time and its finished sessions' tokens across a reattach.
- #180: the checkout of an Attempt closed between a restart and its reattach waits for the next startup to be reconciled.
- #211: startup recovery calls `Executor.recover` four times for the same open Attempt.
- #268: salvage reconciliation fails at every start for Attempts retained on a Worker that `usine.yaml` no longer lists.

## Durable layer

- #179: a poisoned pi-durable session is detected by wrapping storage and matching an error message.
- #181: a Pi child's grep and find tools inherit the orchestrator's environment.
- #182: the durable Pi parent runs without Pi's HTTP dispatcher settings.
- #185: the durable Pi parent's system prompt is only the usine section.
- #187: a crash between an append and the progress commit can lose one envelope that is not derived from a parent entry.
- #195: a task that settles at the moment its relay fails stays live after `stopTask` cancels it.
- #217: `DurableHarness` must handle pi-durable's `SessionFailed` before upgrading past 1.1.0.

## Harnesses

- #227: pull request harvest logs a warning whenever an Attempt's final commit was never pushed.
- #256: Claude preflight on a logged-out Worker does not say to run `claude auth login`.
- #258: the Codex app-server asks for github.com and api.github.com on a Worker behind the Gateway.
- #266: a Codex child that cannot connect to its provider reconnects silently for as long as the Attempt runs.
- No open issue found: `StepResult` allows a `Comment` fact, but `harvestFacts` never records one (`packages/core/src/step/harvest.ts:135`).

## Workers

- #223: the umbrella issue for replacing exe.dev with EU Workers that usine controls, in three stages.
- #228: `usine up` refuses `exe.dev` Workers and mixed Worker kinds (`packages/orchestrator/src/worker-engine.ts:13`, `packages/orchestrator/src/scheduler.ts:76`).
- #196: exe.dev Workers cannot run Pi children.
- #199: canceling an unlaunched live Attempt on exe.dev leaves its remote children running.
- #200: exe.dev recovery no longer stops a run host left by an earlier usine version.
- #201: the exe.dev Worker with SSH children has not run on a real VM.
- #230: an SSH Worker has not run with real Claude Code and Codex children in the tests.
- #231: Attempts on one SSH Worker without a Gateway can read each other's GitHub token.
- #229: the harness versions pinned in `infra/hetzner/cloud-init.yaml` must follow the versions usine supports by hand.
- #257: the live SSH preflight test cases do not show each harness's outcome.
- #270: two Attempts at once thrash a 4 GB Worker until sshd stops answering.
- No open issue found: local and direct SSH preflight do not check the GitHub credential; only the exe.dev preflight raises the `credentials` capability (`packages/executor/src/exe-dev/preflight.ts:123`).

## Gateway

- #234: the Gateway's swap of a Claude subscription token has not been checked against Anthropic.
- #235: the Gateway cannot hold a Codex ChatGPT login with token refresh.
- #236: reloading the egress allowlist or the secrets drops the in-memory attachments.
- #237: the Gateway does not serve GitHub release download URLs or follow repository rename redirects.
- #240: a tunnel opened to an allowed name can be reused for other names on the same certificate (HTTP/2 coalescing, domain fronting).
- #243: Attempts on one machine behind the Gateway can read each other's caller tokens.
- #247: `GatewayDomain` is defined in both `packages/core/src/worker.ts:65` and `packages/gateway/src/settings.ts:10`.
- #249: the executor does not open or keep the SSH forward to a Gateway's admin API; the operator must.
- #251: a refused admin request logs its endpoint as `HttpApiEndpoint`.
- #254: Workers behind the Gateway have no time source.
- #255: a tunnel that the client closes before its ClientHello is logged as a `not-tls` refusal.
- #261: harness turns behind the Gateway ask for hosts outside the egress allowlist.
- #262: `usine-gateway` exits with status 130 when systemd stops it.
- #264: infrastructure changes are applied to a running Gateway only by hand, and never to a running Worker.

## Agent behaviour in the dogfood Loops

- #226: the reviewer Agent pushed a fix commit to a pull request branch although `review-pr` forbids branch edits.
- #241: `act-on-findings` repeats an Attempt that ended with an operator question until the cycle budget is spent.
- #242: a `finish-pr` commit on the local Worker is authored as the operator, not the factory's App.

## Observability

- No open issue found: `apps/server` installs no tracer, so the `Effect.fn` spans are not exported anywhere; only console logs remain.

## Later and other

- #115: v2 task-source port, with local Markdown files as the first source besides GitHub.
- #56: a seed issue used by tests; it is not a gap.

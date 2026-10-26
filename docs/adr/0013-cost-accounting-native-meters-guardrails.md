# Cost accounting: native meters per pool, guardrails not budgets

v1 meters everything and enforces no dollar budget. Usage travels on the attempt channel and is stored per child on the attempt row: harness, model, tokens (input, output, cache read, cache write), and USD where a real or estimable rate exists. Each **pool** (billing source, not harness) keeps its native meter:

- **API keys** (Pi parent and children): Pi reports USD per message.
- **Claude plan** (Claude Code children): estimated USD from the Agent SDK's `modelUsage`, marked as such.
- **ChatGPT plan** (Codex children): tokens plus rate-window percentages from app-server snapshots.

Nothing is converted: a pool without a dollar rate never shows dollars. The only hard limits are guardrails against runaways: a per-attempt **child-session budget** and **runaway guard** (wall-clock and total-token ceilings). Crossing either fails the attempt with a typed error that's never retried automatically.

## Considered options

- **Enforced dollar budgets** (monthly ceilings per loop or instance that stop new runs): rejected for v1. Two of three pools have no dollar meter usine controls, the Claude figure is a client-side estimate from a bundled price table, and approval gates and worker caps already throttle volume. Attempt rows keep what a later budget layer needs.
- **Dollars everywhere** (estimated USD for all, Codex at API-equivalent rates): one comparable but partly fictional number. Rejected for native meters.
- **Engine reacts to pool exhaustion** (hold attempts until the window resets): kinder to retries, but adds scheduler machinery and another "why isn't my run starting". Rejected for display-only pool health.
- **Accounting only, no guards**: rejected; a runaway agent spends until the provider stops it.

## Consequences

- **Revises [ADR 0005](./0005-pi-parent-agent-layer-team-roster.md)**: the announced Agent SDK credit was paused before taking effect. Usage draws the subscription's ordinary windows, and no official API exposes plan balance or usage, so the Claude meter is usine's USD estimate. Rate-limit headers and the undocumented OAuth usage endpoint are display hints at most.
- Usage facts are attempt-channel envelopes: the drawer shows live totals, and the attempt-row summary is written at the end. Rollups (per run, loop, project, pool; per calendar month) query attempt rows (ADR 0010 prunes nothing); there's no separate ledger.
- Guards are `usine.yaml` settings: `max_children` (child sessions per attempt, default 4, replacing the davis extension's concurrent cap), `max_attempt_minutes` (default 60), and `max_attempt_tokens` (parent and children, default 10M). Each accepted spawn logs its count and a bounded task excerpt. Past `max_children`, the run host's Pi parent rejects the spawn and stops with a typed error, recorded as `ChildSessionBudgetFailure`; the drawer and needs-you strip show the configured and attempted counts. The runaway guard meters channel events in the orchestrator and trips through ADR 0006's two-stage interrupt. Its typed failure isn't an infra error, so ADR 0002's automatic retry never applies.
- Pool health is display and warning only: the latest snapshot per pool is stored (Codex pushes window snapshots during runs; an on-demand read exists), the Configuration Usage page shows the three meters, and the needs-you strip warns past a threshold (default 80% of the Codex window). Scheduling ignores it; an exhausted-pool attempt fails with a typed error showing the reset time.
- UI: a per-run cost line (per pool, per child) in the drawer, and one chartless Usage page with current-month rollups per loop and pool. Trends and per-agent breakdowns aren't in v1.
- Per-harness native caps (such as the Claude SDK's `maxBudgetUsd`) remain adapter-internal defense, never the operator-facing guard.

[ADR 0022](./0022-item-cycle-budgets-and-comment-reviews.md) extends this decision with durable item cycle budgets, operator reset asks, and comment-only reviews under the shared App identity.

## Amendment (2026-09-18): opt-in ceilings, an accurate meter, and salvage before cleanup

The runaway ceilings are opt-in: `max_attempt_minutes` and `max_attempt_tokens` have no default, and unset means off. The old defaults (60 minutes, 10M tokens) predated real attempts; large issues take two or three hours, and a tripped guard removed the worktree with finished work in it (#161). An armed ceiling steers the parent once at 80% of its limit, so the agent can commit and push first.

The token meter changed too. The guard summed each harness's cumulative total, which for Codex and Claude rereads the whole context every turn, so counts tracked conversation length, not work: a healthy Codex attempt hit 2M "tokens" in five minutes. `TokenCount` is now output plus uncached input (new prompt text and cache writes), computed per harness from the SDK's separate fields, and shown on the attempt row and drawer whether or not a ceiling is armed.

Separately, every attempt that ends without `Succeeded` salvages its worktree before cleanup: uncommitted changes become a `wip(usine): salvage attempt <id>` commit, and HEAD is pushed to `usine/salvage/<run>/<attempt>`, recorded on the attempt and checked out by the next retry. If the push fails, the worktree stays on the worker and its path is recorded.

## Amendment (2026-10-18, #282): a retry applies the salvage onto the current revision

Checking out the salvage unchanged kept retries on the first attempt's base. An issue run's revision is the default branch tip at each fetch, so retries lacked later fixes, and an attempt that changed nothing re-pushed the old salvage. A retry now refetches the revision and rebases the salvage's own commits onto it, dropping a salvage with nothing beyond the revision. One that doesn't rebase cleanly is left out, not merged with conflict markers: the attempt starts from the revision, its prompt and the transcript's `Started` envelope name the salvage, and the branch keeps the work for reuse.

## Amendment (2026-10-19, #324, #266): lost connectivity is a signal with no default ceiling

On 2026-10-15, a worker accepted TCP but sent no SSH banner for over ten minutes, and a Codex child logged `Reconnecting... waiting for network` every 90 seconds for 40 minutes. Neither attempt failed or said so; the operator found both in harness output. Silent workers and unreachable providers can recover, and an attempt failed during the silence couldn't salvage the checkout. Like the runaway ceilings, connectivity loss has no default limit and fails nothing. It shows in the transcript and logs with its start time, and the operator waits, steers, or cancels.

While an attempt runs on a worker, the executor runs `true` there over a new SSH connection every minute. Nothing else contacts the worker often enough: on 2026-10-15, the children's long-lived SSH sessions survived on keepalives while new connections got no banner, and the executor's own commands run only at cleanup, at the end, or near credential expiry. Harnesses report their own provider retries, which child adapters forward as they arrive.

## Amendment (2026-10-22, #248): a gateway's API key puts Claude Code children in the API keys pool

Claude Code children were always in the Claude plan pool. A worker behind a gateway with the Anthropic credential (`llm_providers: [anthropic]`, [ADR 0027](./0027-gateway-credential-proxy.md)) sends Claude Code requests with it: an API key (`ANTHROPIC_API_KEY`) or a subscription token. API-key children showed as Claude plan estimates, though billed at the model's API rate.

A pool is the billed credential, not the harness ([ADR 0021](./0021-pi-parent-pool-follows-authentication.md)). A Claude Code child that a gateway bills to an API key is in the API keys pool, priced at the model's rate from the Agent SDK's figure, without the estimate mark. Others stay in the Claude plan pool: without a gateway, with the worker's own login, or billed to a gateway subscription token.

The gateway reports each LLM provider's credential kind on its admin API (`GET /v1/providers`: `api-key` or `subscription`). `usine.yaml` has no field for it, since only the gateway knows. The executor reads the kind at the preflight of each worker whose `llm_providers` lists `anthropic` and records it with the worker, and each child session records the kind used (`ChildSession.gatewayCredential`), so later changes don't alter earlier pools. Preflight fails if a worker lists Anthropic and its gateway has no Anthropic credential, since every Claude Code request would be refused. A gateway that predates the endpoint answers 404: its workers keep the Claude plan pool, with one warning per worker, and later preflights ask again.

The kind is read at preflight, not per attempt. A gateway reload that swaps key and token applies to new sessions after the worker's next preflight: orchestrator start, or a configuration reload that adds the worker, gives it slots, or adds a roster brain. Each child session takes the worker's recorded kind at start, so a running attempt's next child gets the new one.

## Amendment (2026-10-26, #566): the ChatGPT plan gets a client-side estimate

A ChatGPT plan session had no dollar figure, so any task with one showed no cost on the Overview. On the dogfood instance, the Pi parent runs on the ChatGPT plan, so that was every task. The ChatGPT plan now gets a client-side estimate like the Claude plan, and "a pool without a dollar rate never shows dollars" no longer holds. The rate windows stay the plan's native meter.

`@usine/agents` bundles OpenAI's API rates per model: input, cached input, cache write, and output per million tokens, read from OpenAI's pricing page on a stated date. A Codex token report splits its tokens by rate, and the usage reader prices a Codex session that its harness didn't price at read time. The price is marked as an estimate in the ChatGPT plan, and not in the API keys pool, where a gateway's OpenAI key bills those rates. A harness's own figure still comes first: the Agent SDK's for Claude Code, and Pi's for the parent, which prices `openai-codex` models from its catalog. A model that the table lacks stays unpriced, with one warning per model, and is never guessed.

The table is a maintenance cost: a new Codex model or an OpenAI price change needs an edit, and a test fails if a supported Codex CLI version lists a model without rates. It's accepted so the Overview shows a cost per task.

# Pi parent pool follows its authentication method

The Pi parent accepts API-key models and Pi's `openai-codex` ChatGPT subscription models. At session start, `@usine/agents` assigns it to `apiKeys` or `chatgptPlan` by Pi's resolved authentication. OAuth providers without a usine pool stay unavailable; Pi children stay API-key-only. This revises [ADR 0005](./0005-pi-parent-agent-layer-team-roster.md) and [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md): a pool is the billed credential, not the sending runtime.

## Considered options

- **API keys for every Pi session**: simple accounting, but rejects Pi's ChatGPT provider after the SDK created the session.
- **Every OAuth provider as a subscription pool**: more providers, but GitHub Copilot, xAI, and generic OAuth fit no billing source without reporting false usage.
- **Pool from authentication and provider** (chosen): accepts both supported parent paths and rejects billing usine can't represent.

## Consequences

- API-backed parents use `openai/...` or similar API-key ids; ChatGPT-backed ones use `openai-codex/...`. Switching edits only the parent model.
- The parent-start log includes the effective model and pool. Only Codex children emit `PoolRateLimitsUpdated` for `chatgptPlan`; the Pi adapter emits no app-server rate-window snapshots.
- A subscription-backed Pi child session is disposed before starting, with a `PoolUnavailableError` saying Pi children need the API-key pool.

## Amendment (2026-11-04, #941): Pi children accept the ChatGPT pool

Pi children accept the same authentication as the parent: API keys and Pi's `openai-codex` ChatGPT subscription login. The SDK already resolves both pools from the provider's authentication; the child-only API-key restriction predates the parent's ChatGPT support and serves no separate requirement. This replaces the API-key-only child rule above.

Preflight accepts a supported Pi credential on a local worker, and child launch records the resolved model. Usage follows that model into `apiKeys` or `chatgptPlan`, as for the parent. OAuth providers without a usine pool remain unavailable. Pi sessions emit no plan rate windows, so usine cannot warn before they reach the ChatGPT plan limit.

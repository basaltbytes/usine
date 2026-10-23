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

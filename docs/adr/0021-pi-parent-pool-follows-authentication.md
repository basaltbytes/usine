# Pi parent pool follows its authentication method

The Pi parent accepts API-key-backed models and ChatGPT subscription models from Pi's `openai-codex` provider. At session start, `@usine/agents` reads Pi's resolved authentication method and assigns the parent to `apiKeys` or `chatgptPlan`. OAuth providers without a defined usine pool remain unavailable. Pi children remain API-key-only.

This revises [ADR 0005](./0005-pi-parent-agent-layer-team-roster.md) and [ADR 0013](./0013-cost-accounting-native-meters-guardrails.md). A Pool describes the credential that pays for a request, not the runtime that sends it.

## Considered Options

- **Require API keys for every Pi session** — simple accounting, but it rejects Pi's ChatGPT subscription provider after the SDK has created the session.
- **Treat every OAuth provider as a subscription pool** — permits more providers, but usine cannot assign GitHub Copilot, xAI, or generic OAuth to any of its three billing sources without reporting false usage.
- **Resolve the pool from authentication and provider** — accepts the two supported parent paths and rejects credentials whose billing source usine cannot represent.

## Consequences

- An API-backed parent uses an `openai/...` or other API-key-backed model id. A ChatGPT-backed parent uses `openai-codex/...`; changing between them requires only a parent-model configuration edit.
- The structured parent-start log includes the effective model and pool. The Pi adapter does not emit Codex app-server rate-window snapshots, so only Codex children emit `PoolRateLimitsUpdated` for that pool.
- A subscription-backed Pi session created for a Pi child is disposed before the child starts. The resulting `PoolUnavailableError` states that Pi children require the API-key pool.

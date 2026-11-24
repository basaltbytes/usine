---
"@usine/agents": minor
"@usine/cloudflare": patch
---

Workers install Codex CLI 0.172.0, which offers `gpt-6.2-astra` and `gpt-6.2-sol`. The app-server protocol baseline stays at 0.164.0, the latest release with a published `@pwrdrvr/codex-app-server-protocol` package. `CODEX_CLI_VERSION` is now the installed release and no longer equals `CODEX_PROTOCOL.version`. Preflight accepts 0.172.0, 0.164.0, and 0.159.0 through 0.159.3, so workers built from older images pass until they are rebuilt. The worker image tag, the Hetzner cloud-init, and the Cloudflare sandbox image install 0.172.0.

When Codex's `model/list` lacks the requested model, the `UnknownModelError` message and the `Codex rejected an unknown model` log entry list the model IDs that Codex offers and the Codex CLI version that the app server reports. `initializeCodex` returns that version, read from the `initialize` user agent, and `checkCodexModel` takes it.

The OpenAI price table adds `gpt-6.2-astra`, `gpt-6.2-sol`, and `gpt-6.1-terra`.

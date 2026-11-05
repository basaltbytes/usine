# OpenCode 2.2.5 adapter verification

Verified on 2026-11-05 for #958 against the exact npm binary `@opencode/cli-linux-x64@2.2.5` and the [v2.2.5 source](https://github.com/anomalyco/opencode/tree/v2.2.5). The public install package is `@opencode/cli@2.2.5`; its version output is `opencode v2.2.5`.

## Transport and child contract

[ACP rejects concurrent prompts for a session](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/acp/turn.ts), so it cannot accept steering while the first prompt runs. The adapter uses the HTTP session inbox, which accepts `delivery: "steer"` and emits `session.inbox.delivered` when the input is read.

The real CLI passes the shared steering and interruption contracts locally and through the SSH forwarding shim. The contracts verify the command's environment and remote PID file, steering before command completion, result and event-stream agreement, and command termination before scope cleanup. The controlled provider requests OpenCode's `shell` tool and returns the steering marker from the next request. It uses no external provider account.

Run these checks with the pinned CLI on `PATH`:

```sh
USINE_OPENCODE_CONTRACT_FIXTURE=true pnpm --filter @usine/agents test:integration:opencode
```

Set `USINE_OPENCODE_INTEGRATION_MODEL=provider/model` instead to run the shared contracts with the worker's configured provider and credentials. Provider-account and paid-model behavior require those credentials; the controlled endpoint verifies the real CLI and transport protocol.

## Findings for the study's unverified items

| Item | Finding and evidence |
| --- | --- |
| Ignore project configuration | The real-server test places a provider override in `opencode.json` and a throwing plugin in `.opencode/plugins`. `OPENCODE_CONFIG_PROJECT_DISABLE=1` excludes both; effective configuration has no override and the session starts. [Configuration discovery](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/config/discovery.ts) gates project roots. |
| Repository instructions | [Instruction discovery](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/instruction-discovery.ts) has a separate policy, enabled by default. Disabling project configuration retains AGENTS instructions. `OPENCODE_DISABLE_CLAUDE_CODE=1` excludes `.claude` skills. |
| Headless `ask` | The real-server test sets a session-level ask policy, observes `permission.asked`, and confirms the command has not run. Interrupt stops the waiting session. Normal adapter launch supplies an allow policy; an unexpected ask fails the child. |
| Model and effort checks | `GET /api/model?directory=...` returns enabled models and variants after plugin activation. The adapter checks the full `provider/model` ID and requested variant before creating a session. Real host preflight sends no provider request. |
| Authentication output | 2.x provides `opencode auth list --format json`. The adapter uses the structured `GET /api/integration` response and its first, active connection. [Connection resolution](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/integration.ts) prioritizes saved credentials over environment keys. |
| Interactive handoff | The [root CLI](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/commands/commands.ts) accepts `--session <id>` in the checkout. Sessions and credentials are in OpenCode's data database; containers mount `.local/share/opencode` and seed `.config/opencode`. |
| MCP and supplied tools | [ACP session attachment](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/acp/sessions.ts) registers stdio and HTTP MCP servers. This adapter does not supply usine tools and declares that capability absent. |
| Startup catalog fetch | `OPENCODE_DISABLE_MODELS_FETCH=1` disables the remote catalog fetch in [server startup](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/server-process.ts). The bundled catalog and explicit provider models remain available. |
| OpenAI gateway request shape | Real-CLI tests render the descriptor's gateway recipe and capture `POST /openai-responses/v1/responses`, an uncompressed HTTP SSE request with `store: false` and an `instructions` string. A controlled Responses stream completes the child for both gateway credential kinds. The gateway already forwards this route and maps `/v1/responses` to `/responses` for ChatGPT. |
| Host ChatGPT login | The [OpenAI provider](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/provider/openai.ts) registers ChatGPT OAuth methods and selects the Codex endpoint for an active OAuth login. The adapter records `chatgptPlan` for that active connection. Pool and credential-priority tests use the structured server contract; no external ChatGPT account is exercised by the controlled fixture. |

## Limits

SSH needs TCP forwarding, and SSH containers need host networking. The executor supplies host networking for attempt containers. Cloudflare sandbox admission refuses OpenCode because its shell transport has no TCP forwarding.

An unexpected event-stream disconnect fails with `SessionOperationError`. The saved OpenCode session remains available for terminal handoff. Subscription allowance windows and durable coordinator guarantees are not exposed by this adapter. Claude subscriptions require the Claude Code adapter.

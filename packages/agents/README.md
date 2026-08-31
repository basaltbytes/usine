# @usine/agents

The agent runtime for [usine](https://github.com/basaltbytes/usine). Each Attempt starts an in-process Pi parent, which can delegate focused work through the usine-owned `subagent` tool. An agent's brain spec selects Claude Code, Codex, or Pi for the child.

The package root is platform-free. It exports prompt assembly, normalized session events, typed runtime errors, and the `AgentRuntime` and `ChildBackend` service contracts. The Node implementation lives at `@usine/agents/pi`:

```ts
import { layer as agentLayer } from "@usine/agents/pi"
```

The production layer resolves the Pi parent model from the Run spec, installs the subagents extension, and dispatches each child from the rostered `harness` field. Claude Code runs with `bypassPermissions` and reads only worker-user settings. Codex uses app-server JSON-RPC over standard input and output with `approvalPolicy: never`; its thread stays ephemeral and records ChatGPT plan rate-window updates as `PoolRateLimitsUpdated` session events. Pi children use the Pi SDK and reject OAuth-backed models so they cannot leave the API-key pool.

The Attempt worktree counts as repository-controlled input. Pi ignores project `.pi/` settings, extensions, prompt templates, skills, and themes. Claude omits project setting sources, while Codex marks the worktree untrusted before starting its thread. AGENTS instructions remain available to the coding harnesses. Worker isolation remains the executor's responsibility.

Parent and child output becomes typed session events: `SessionStarted`, `TextOutput`, tool calls, pool observations, and `SessionFinished`. Each completed assistant message produces one `TextOutput`; streaming deltas don't enter the Attempt transcript. Parent and child controls support steer and interrupt. A child session always names one parent session, so recursive child events cannot enter the public model.

Model identifiers stay opaque until the selected harness checks its registry. Agent-reported failures use `AgentResultError`; SDK, process, and protocol failures use `SessionOperationError`. `toAttemptFailure` maps only `SessionOperationError` to retryable infrastructure failure.

The worker's home directory must contain Pi provider API keys, Claude Code login state, and Codex login state. Pi parent and Pi child usage draws from API-key pools, Claude children draw from the Claude plan, and Codex children draw from the ChatGPT plan. The harness SDK and protocol dependencies use exact versions.

Run the opt-in live contracts with explicit models:

```sh
USINE_CODEX_INTEGRATION_MODEL=gpt-5.6-terra pnpm --filter @usine/agents test:integration:codex
USINE_PI_INTEGRATION_MODEL=anthropic/claude-sonnet-4-6 pnpm --filter @usine/agents test:integration:pi
```

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.

---
"@usine/agents": minor
---

`HarnessRuntime.open` takes an `effect/ai` `Toolkit` as its last argument and serves it to the session as a usine tool set. The handlers come from the calling context, so the role that opens the session decides what each call can reach. Claude Code serves the toolkit as the in-process MCP server `usine`, over the CLI's own stdio, and loads its tools in the first prompt. Pi serves it as custom tools. A role with `nativeTools: false` gets a session that lists only the toolkit's tools: Claude Code starts with no built-in tool and ignores other MCP configuration, and Pi activates none of its own tools.

`ToolStarted` and `ToolFinished` carry the toolkit's names without a harness prefix. A name that a harness can't carry gets a stable alias that maps back. A handler failure, invalid parameters, an input that isn't JSON, or a handler defect returns an error result to the model, and the session continues. An alias is logged at Info, and an input that isn't JSON is logged as a warning. The registry refuses a session that opens with a toolkit when its role runs no usine tool set, or without one when its role runs one.

The Claude Code and Pi descriptors declare `usine-tools` and `closed-tools`, which the new `host-tool` and `closed-tools` contract scenarios prove for both. Codex still lacks `usine-tools`, with a reason that names step 19 of the harness adapter plan. `ClaudeSdk.open` takes the session's tool server as a third argument, and `PiStartOptions` adds `nativeTools` and `hostTools`.

# @usine/agents

The agent runtime for [usine](https://github.com/basaltbytes/usine). Each Attempt starts an in-process Pi parent, which can delegate focused work to a headless Claude Code child through the usine-owned `subagent` tool.

The package root is platform-free. It exports prompt assembly, normalized session activity, typed runtime errors, and the `AgentRuntime` and `ChildBackend` service contracts. The Node implementation lives at `@usine/agents/pi`:

```ts
import { layer as agentLayer } from "@usine/agents/pi"
```

The production layer resolves the Pi parent model from the Run spec, installs the subagents extension, and starts children with the rostered brain spec. Claude Code receives the agent persona and task through streaming input; it runs with `bypassPermissions`, does not persist its session, and inherits the Attempt worktree. Worker isolation remains the executor's responsibility.

Parent and child output becomes typed `SessionStarted`, `TextOutput`, `ToolStarted`, `ToolFinished`, and `SessionFinished` activity. Parent controls support steer and interrupt. A child session always names one parent session, so recursive child activity cannot enter the public model.

Model identifiers stay opaque until the selected SDK checks its registry. `UnknownModelError`, `UnsupportedHarnessError`, and `SessionOperationError` remain distinct in the typed channel. The production layer accepts Claude child brains; another harness returns `UnsupportedHarnessError` before a child starts.

The worker's home directory must contain working Pi provider credentials and Claude Code login state. Both SDK dependencies use exact versions because their adapter surfaces are still 0.x.

Everything here is 0.x, so APIs can change between minor releases. Supply `effect` at the version pinned by the usine workspace.

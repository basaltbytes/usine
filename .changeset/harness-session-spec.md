---
"@usine/agents": minor
---

The harness runtime seam no longer names a role. `HarnessRuntime` has `open(spec, start, continuation)` and `stop(spec)` next to `preflight`, and no longer extends `ChildBackendService`. `@usine/agents/harness/contract` exports `SessionSpec`, the session's identity, placement and credential route, host, worker, machine, checkout, and environment; `StartPrompt` and `StartResume`, which start a conversation or reopen a saved one; and `NativeSession`, which `open` returns. Claude Code, Codex, and Pi read only the spec and the continuation policy, so any role can open a session. A runtime from `Harnesses` admits the spec's brain at its placement and credential route before opening it, and requires `resume-session` to reopen a saved conversation.

`childContinuation(catalog, runtime)` in `@usine/agents/continuation` builds child launch, resume, and stop over a runtime. It admits each `ChildRequest` with the catalog and splits it into a spec and a `RestartState`, exported from `@usine/agents/runtime`, which the continuation policy carries as `restored`. `continuationPolicy(spec, task, restored)` makes that policy for any spec. The single-harness `ChildBackend` layers admit children with their own descriptor.

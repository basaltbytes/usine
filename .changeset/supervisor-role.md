---
"@usine/agents": minor
"@usine/config": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

The supervisor is a role of the harness contract. `@usine/agents/harness` exports `supervisor`, a role that runs on the orchestrator on a gateway credential route, lists only its usine tool set, keeps its conversation between turns, and takes interventions, and `admitSupervisor`, which requires `usine-tools`, `closed-tools`, `resume-session`, `steer`, `interrupt`, and `token-usage`. `@usine/agents/supervisor` exports `runSupervisorTurn`, which opens a supervisor session through `Harnesses` with a toolkit, or reopens the saved session for the conversation's next turn, and returns the answer, the saved session, and the session's cumulative usage across turns. A failed turn returns `SupervisorTurnError` with the usage that the session had spent. When a Claude Code process resumes a session, the first result's `modelUsage` minus its `model_usage_since_last_result` is the usage that Claude restored. usine counts that usage once and logs it at Info. This applies to a replacement process and to a process that the adapter resumes after its remote process stops.

`settings.supervisor: { harness, model, effort }` selects the supervisor's brain. Saving the configuration refuses a harness that can't serve the role and names what it lacks; Codex is refused until it serves usine tool sets. An instance without the setting starts, and `SettingsView.supervisor` is null, which **Configuration > Settings** shows as not configured. The settings form edits the brain.

The server builds the supervisor's operator toolkit from the operator tools that the MCP endpoint serves, filtered by the member's grants and operation ceiling, and answers each call through the operator API with the member's credential.

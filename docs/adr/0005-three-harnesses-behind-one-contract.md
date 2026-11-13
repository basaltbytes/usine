# Three harnesses behind one contract; roles state what they need

usine works with whichever model provider and login the operator has. It maintains three harnesses, none of them the default or folded into another:

- **Pi** reaches API keys across providers, and the ChatGPT subscription through its `openai-codex` login. Its other subscription logins are refused, since usine can't represent their billing ([ADR 0013](./0013-cost-accounting-native-meters-guardrails.md)).
- **Claude Code** is the only client that a Claude subscription works in.
- **Codex** is the ChatGPT subscription's client.

Every role (the coordinator, the coding agent, the supervisor) is written against the harness contract in `@usine/agents` and names no harness or provider. A role declares what it needs, and usine derives the capabilities from it. Each harness descriptor states what it provides for each placement and credential route, and why it lacks the rest. `admitBrain` compares the two at save, preflight, and launch, so a refusal names what is missing. A role uses the attempt's credential; the supervisor, which has no attempt, uses the instance's gateway credential.

An agent is standing instructions plus a brain spec: harness, model, and effort. A loop names an agent, so changing a loop's model edits the agent. usine validates the harness and effort and passes model IDs through, so a new model needs no release; a model the harness rejects fails the attempt.

## Status

Built: harness runtimes and descriptors, a role-neutral session spec (#1203), roles as declarations (#1204), usine tool sets and a structured `complete` on all three (#1205, #1206, #1208), and the supervisor role on all three (#1267, #1280). Codex lacks `closed-tools`, because some of its own tools stay on in every thread: it refuses roles that close them, and keeps all its tools for a role that keeps only read tools, such as the supervisor, whose read-only container limits them. The coding agent runs on all three; Pi on local workers only. `coordinator: session | events` (#1158) selects the Pi parent, which Claude Code and Codex refuse, or the event-driven coordinator (#1157).

## Considered options

- **Pi alone**: no Claude subscription.
- **A Pi parent session that delegates to vendor children**: the parent needs its own model credential, so a Claude subscription alone can't start a run (#1149).
- **Per-vendor adapters without a shared contract**: each role written once per harness.
- **A second model path**, such as an `effect/ai` client for small decisions: duplicate configuration, admission, and accounting.

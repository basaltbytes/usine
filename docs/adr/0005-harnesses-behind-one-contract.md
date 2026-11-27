# Harnesses behind one contract; roles state what they need

usine works with whichever model provider and login the operator has. It maintains four harnesses, none of them the default or folded into another:

- **Pi** reaches API keys across providers, and the ChatGPT subscription through its `openai-codex` login. Its other subscription logins are refused, since usine can't represent their billing ([ADR 0013](./0013-cost-accounting-native-meters-guardrails.md)).
- **Claude Code** is the only client that a Claude subscription works in.
- **Codex** is the ChatGPT subscription's client.
- **OpenCode** runs on an OpenAI API key, from the attempt or the gateway, behind a bridge on the worker.

Every role (the coordinator, the coding agent, the supervisor) is written against the harness contract in `@usine/agents` and names no harness or provider. A role declares what it needs, and usine derives the capabilities from it. Each harness descriptor states what it provides for each placement and credential route, and why it lacks the rest. `admitBrain` compares the two at save, preflight, and launch, so a refusal names what is missing. A role uses the attempt's credential; the supervisor, which has no attempt, uses the instance's gateway credential. A harness is one folder and one catalog entry.

An agent is standing instructions plus a brain spec: harness, model, and effort. usine validates the harness and effort and passes model IDs through, so a new model needs no release; a model the harness rejects fails the attempt.

## Status

Built: runtimes and descriptors, a role-neutral session spec (#1203), roles as declarations (#1204), usine tool sets, a structured `complete`, and the supervisor role on Pi, Claude Code, and Codex (#1205, #1206, #1208, #1267, #1280). Codex lacks `closed-tools`, so it keeps all its tools for a read-only role, such as the supervisor, whose container limits them. OpenCode serves usine tool sets (#1386) but runs only on workers, so not the supervisor. Pi runs children on local workers only. Every new attempt runs on the event-driven coordinator (#1157, #1166); the Pi parent runs only the attempts that earlier versions started with it.

## Considered options

- **Pi alone**: no Claude subscription.
- **A Pi parent that delegates to vendor children**: the parent needs its own model credential (#1149).
- **Per-vendor adapters without a shared contract**: each role written once per harness.
- **A second model path**, such as an `effect/ai` client for small decisions: duplicate configuration, admission, and accounting.

---
"@usine/agents": minor
---

Roles are declarations. `@usine/agents/harness` exports `RoleSpec`, with `RolePlacements` and `RoleCredentials`, and `requirements(role)`, which derives a role's capabilities from its tools, persistence, interventions, and output. `codingAgent` declares the coding agent; the `Role` literal is gone. `admitBrain(catalog, role, brain, context, { reopens })` takes a `RoleSpec`, refuses a placement or credential route outside the role's lists with the role's reason, and requires `resume-session` only to reopen a saved conversation. `BrainRefused.role` is the role's name.

The capabilities add `closed-tools`, `structured-output`, and `ephemeral`. Descriptors declare only what contract scenarios prove, so Claude Code, Codex, and Pi lack `usine-tools`, and admission refuses the supervisor on every harness.

`AdmittedBrain` carries the role and the billing pool that the credential route determines, and `SessionSpec.admitted` replaces `SessionSpec.route`, so a registered runtime admits each session for its own role. `piSdkLayer(sources)` builds the Pi SDK layer from a model runtime and a settings directory.

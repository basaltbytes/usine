---
"@usine/orchestrator": minor
"@usine/server": patch
---

A refused `POST /api/instance/reload` answers with the refusal's typed fields beside `error` and `message`: `blocks` and `fields` for `RestartRequiredError` (409), `agents`, `workers`, and `cause` for `ReloadPreflightError` (409), and `file` and `stage` for `FactoryConfigError` (422). `cause` names the failed Worker capability and its Worker, the failed Worker operation, or the repository whose credential could not be obtained; what the check observed stays on the server.

`@usine/orchestrator/operator/http` exports the reload endpoint's error schemas, `RestartRequiredRefusal`, `ReloadPreflightRefusal`, and `FactoryConfigRefusal` (`ReloadRefusal`), `ReloadPreflightFailure`, and `reloadRefusal`, which builds the refusal for an `InstanceReloadError`. The derived client decodes a refused reload into one of them.

The web UI's Configuration section lists what a refused reload names under its message, each linked to its page: the changed `usine.yaml` fields for a change only a restart applies, and for a failed preflight the Worker whose check failed, the Agents and Workers the reload adds, or the repository without a credential.

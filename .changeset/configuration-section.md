---
"@usine/orchestrator": minor
"@usine/server": minor
---

`GET /api/configuration` returns the instance folder as the orchestrator parsed it, beside its runtime state: each Loop's trigger, condition, selector, approval, cycle limit, permissions, Step, Agent, prompt, and paused flag; each Agent's brain, persona, resolved parent model and effort, and Loops; each Worker's settings, Gateway settings with the admin token's variable name only, slots in use, and last preflight per harness; each repository's lanes and labels as polling last read them; the settings, the operator, and the webhooks mode; and every quarantined Loop and invalid Agent with its error. It also answers in setup mode.

`@usine/orchestrator/operator` exports `OperatorConfiguration` and the `ConfigurationView` it returns. `stepExecutorLayer` also provides `WorkerStatus`, exported at `@usine/orchestrator/worker-status`, which reads each Worker's slots and the last preflight of its prerequisites and of each harness, from startup and from every reload that preflights, a refused one included. The local, SSH, and exe.dev compositions pass it on, and `operatorObservationLayer` provides `OperatorConfiguration` with `WorkerStatus.idle`.

The web UI's Configuration section has five pages, Loops, Agents, Workers, Repositories, and Settings, each a full-width list with a read-only detail page. A Loop's page shows its trigger and selector as written and its prompt as Markdown with each `{{ }}` expression outlined. **Reload configuration** sits in the heading of every page of the section, and what the reload changed, or why it was refused, stays on the page.

# Usage is metered per billing pool that harnesses declare; guards are opt-in and keep the work

usine records usage and enforces no dollar budget. Each session records its billing pool at launch, from its resolved credential. A pool is the billed credential, not the harness: Claude Code on a gateway API key bills API keys, and Pi on the `openai-codex` login bills the ChatGPT plan. usine refuses a credential whose billing no pool states, rather than report false usage.

Pools are harness catalog data. A descriptor declares each pool that its sessions bill, with the credential routes that determine it: an ID, a label, plan or metered, and how harnesses report its plan windows. A harness or login with its own plan adds its pool in its own folder; usage, statistics, plan windows, and the web read the catalog. Stored IDs keep their meaning, and sessions recorded before pools infer theirs in one function.

Each pool keeps its native meter: the harness's price or, for Codex, the bundled OpenAI price table, marked as an estimate in plan pools. A model missing from the table stays unpriced, making the total a lower bound. Token counts are output plus uncached input, because cumulative totals reread the context every turn. Pool health is warned about, never used for scheduling.

The only hard limits guard against runaways, per attempt: a child-session budget (`max_children`, default 4) and wall-clock and token ceilings (`max_attempt_minutes`, `max_attempt_tokens`), off unless set. An armed ceiling warns the agent at 80 percent so it can push first. A tripped guard salvages the checkout (ADR 0006) and fails the attempt with a typed error, never retried automatically. An unresponsive worker has no limit; the operator decides.

## Considered options

- **Enforced dollar budgets**: plan pools have no dollar meter that usine controls.
- **Dollars everywhere at API rates**: one comparable but partly fictional figure.
- **Holding attempts until a plan window resets**: more scheduler machinery and unexplained waits.
- **Default ceilings**: large issues take hours, so a default ceiling fails healthy attempts (#161).
- **A pool per harness**: showed Claude Code on a gateway API key as plan usage (#248).
- **Every OAuth login as a plan pool**: logins such as GitHub Copilot fit no billing source usine can report.
- **A closed set of pools in core**: each new plan changed core, the engine, the operator views, and the web (#1379).

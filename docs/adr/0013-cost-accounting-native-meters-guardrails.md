# Usage is metered per billing pool; guards are opt-in and keep the work

usine records usage and enforces no dollar budget. Each session records its billing pool at launch, from the credential it resolved: `apiKeys`, `claudePlan`, or `chatgptPlan`. A pool is the billed credential, not the harness: a Claude Code session on a gateway API key is in the API keys pool, and Pi on the `openai-codex` ChatGPT login is in the ChatGPT plan pool. Behind a gateway, the pool follows the credential kind that the gateway reports. usine refuses a credential whose billing source it can't represent, such as another provider's OAuth login in Pi, rather than report false usage.

Each pool keeps its native meter. A session's price is the harness's own figure or, for Codex, which reports none, the bundled OpenAI price table. Prices in the two plan pools are marked as estimates. A model missing from the table stays unpriced, and the total shows as a lower bound. Claude Code and Codex report plan usage windows; Pi doesn't. Token counts are output plus uncached input, because the harnesses' cumulative totals reread the whole context every turn.

Pool health is shown and warned about, never used to schedule attempts.

The only hard limits guard against runaways, per attempt: a child-session budget (`max_children`, default 4) and wall-clock and token ceilings (`max_attempt_minutes`, `max_attempt_tokens`), which are off unless set. An armed ceiling warns the agent at 80 percent so it can push first. A tripped guard fails the attempt with a typed error that is never retried automatically, and the checkout is salvaged first (ADR 0006). An unresponsive worker has no limit: it shows in the transcript with its start time, and the operator decides.

## Considered options

- **Enforced dollar budgets**: two pools have no dollar meter that usine controls, and plan prices are client-side estimates.
- **Dollars everywhere at API rates**: one comparable but partly fictional figure.
- **Holding attempts until a plan window resets**: more scheduler machinery and another "why isn't my run starting".
- **Default ceilings**: large issues take two or three hours, so a default ceiling fails healthy attempts (#161).
- **A pool per harness**: showed Claude Code on a gateway API key as plan usage (#248).
- **Every OAuth login as a subscription pool**: logins such as GitHub Copilot or xAI fit no billing source that usine can report.

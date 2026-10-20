---
"@usine/core": minor
"@usine/agents": minor
---

`harvestFacts` and `harvestPostedComments` record a comment or review on the Run's Item only when its body ends with the signature of the Attempt's Agent, ignoring trailing whitespace. Every Attempt writes as the same bot login, so two Attempts of different Agents working on one Item at the same time, such as two Loops' Runs on one pull request, no longer record each other's comments. A comment without the signature, or with another Agent's signature, is left out, and the harvest's log line counts these as `unsigned`.

`@usine/core/agent` exports `githubSignature`, the `— usine agent: <name>` line every Agent ends its GitHub comments, issues, pull requests, and reviews with. `@usine/agents/prompt` no longer exports it; import it from `@usine/core/agent`. `HarvestSpec` also reads the RunSpec's `agent`.

---
"@usine/core": minor
"@usine/agents": minor
---

`harvestFacts` and `harvestPostedComments` record a comment or review only if its body ends with the signature of the attempt's agent, so attempts of two agents on one item no longer record each other's comments. The harvest log counts other comments as `unsigned`.

`githubSignature` moves from `@usine/agents/prompt` to `@usine/core/agent`, and `HarvestSpec` reads the RunSpec's `agent`.

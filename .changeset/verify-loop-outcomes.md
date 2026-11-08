---
"@usine/core": patch
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/github": minor
"@usine/server": patch
---

Add `outcome_labels` to require a GitHub verdict before an agent completion succeeds, with a fresh labels-only read and a visible failure when the verdict is missing. Retry failed verification reads twice; if verification remains unavailable, require operator attention without rerunning the agent.

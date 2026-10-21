---
"@usine/expression": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

The operator API's `/api/overview` and `/api/desk` answer in under 200 ms when the web UI polls them together, on a Board of 500 Items and five Loops while an Attempt starts. They used to take over 700 ms each, and seconds on the dogfood instance. Both evaluate every Loop's trigger on every Board Item on the same event loop, and almost all of that time was spent around the CEL evaluations rather than in them.

`MarcbachmannCelLayer` builds the cel-js environment of each `Environment` once for checking and once for evaluation, instead of on every call. It also keeps each expression's check result and parsed form, so the same expression is no longer parsed twice per evaluation. Normalizing a context is compiled once per descriptor and copies an object rewriting only the fields that change.

`ExpressionEngine` gains `evaluateBooleanEach`: it checks a condition once and evaluates it on many contexts in one call, each context's evaluation failure kept to that context. An implementation of `ExpressionEngineService` must now provide it. `LoopMatches`, behind the overview and the desk, evaluates each Loop's trigger on all of a repository's Items with it.

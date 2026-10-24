---
"@usine/expression": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

`/api/overview` and `/api/desk` respond in under 200 ms when polled together on a board of 500 items and five loops, down from over 700 ms each. `MarcbachmannCelLayer` builds each cel-js environment once and caches each expression's check result and parsed form.

`ExpressionEngine` adds `evaluateBooleanEach`, which checks a condition once and evaluates it on many contexts, with failures kept per context; implementations of `ExpressionEngineService` must provide it. `LoopMatches` uses it.

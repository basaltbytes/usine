---
"@usine/expression": minor
---

Add `checkInteger` and `evaluateInteger` to `ExpressionEngine` for CEL expressions returning `int`. Evaluation returns a `bigint` to preserve precision. Implementations of `ExpressionEngineService` must provide both methods.

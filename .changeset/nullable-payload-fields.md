---
"@usine/expression": patch
"@usine/config": patch
---

Declare the GitHub payload fields that can be null as nullable in the CEL environment. On a null field, a comparison with a value is false, a comparison with `null` works in either order, and `has()` of a field below it is false, while reads below a nullable object stay type-checked when the Loop loads. A team review request's `requestedReviewer.login` reads as `null`. `ObjectField` takes a `nullable` flag, and prompt interpolation accepts a `null` result.

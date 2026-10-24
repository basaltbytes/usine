---
"@usine/expression": patch
"@usine/config": patch
---

Loop expressions can use CEL optional values, such as `item.?milestone.?title.orValue("none")`, which is `"none"` on an issue without a milestone. `relatedStringLiterals` accepts the same syntax, so a loop that uses `.?` no longer makes the instance load without undeclared-label warnings.

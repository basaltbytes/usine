---
"@usine/expression": patch
"@usine/config": patch
---

Loop expressions can use CEL optional types: `.?` and `[?]` selection, and `optional` helpers such as `orValue`. `item.?milestone.?title.orValue("none")` renders `"none"` on an issue without a milestone, and an absent map key falls back the same way. `relatedStringLiterals` parses with the same options as checking, so a loop that uses `.?` no longer fails the undeclared-label analysis, which used to drop every undeclared-label warning of the instance.

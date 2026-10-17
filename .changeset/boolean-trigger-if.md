---
"@usine/config": patch
---

A Loop's `if:` accepts an unquoted YAML `true` or `false` as the CEL literal. Other values that YAML does not read as a string fail with a message that says to quote them.

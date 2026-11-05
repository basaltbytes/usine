---
"@usine/config": patch
---

Allow PR loop conditions and task templates to read `item.baseRefOid`. The field evaluates to `null` for older stored payloads that omit it.

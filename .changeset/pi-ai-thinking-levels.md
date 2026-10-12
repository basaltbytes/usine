---
"@usine/agents": patch
---

The Pi backend checks a model's effort with `getSupportedThinkingLevels` from `@earendil-works/pi-ai`, the rule the Pi parent already uses, instead of its own copy. `@usine/agents` now depends on `@earendil-works/pi-ai` 1.1.0 directly.

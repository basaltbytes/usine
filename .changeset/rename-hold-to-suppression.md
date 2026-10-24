---
"@usine/engine": minor
"@usine/orchestrator": minor
---

Renames the item-level hold to suppression, so hold means only the session hold. In `@usine/engine/engine`, the `Held` submission result becomes `Suppressed`, and in `@usine/engine/run-reader`, `LoopSighting.heldBy` becomes `suppressedBy`. In `@usine/orchestrator/operator`, `HeldForOperatorView` becomes `SuppressedForOperatorView`, whose tag is `SuppressedForOperator`. A migration renames the `usine_loop_items` columns `held_by_run_id` and `held_event_id` to `suppressed_by_run_id` and `suppressed_event_id` and keeps their values.

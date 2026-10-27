---
"@usine/core": minor
---

Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). `CycleBudgetAsk`, `LoopCycleCount`, `RunAgain`, and `ApprovalSource` still reject a key they don't declare, whatever `onExcessProperty` the decoder passes. Effect 4.0 no longer reads the `parseOptions` annotation that made them strict.

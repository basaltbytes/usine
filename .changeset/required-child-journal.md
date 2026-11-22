---
"@usine/agents": minor
---

`ChildBackend.launch` requires `ChildSessionJournal` from its context, so a durable delegation that leaves out its journal is a type error instead of a child whose checkpoints are silently dropped. `ChildSessionJournal.current`, which fell back to a journal that saved nothing, is removed. `ChildSessionJournal.noop` is that journal, for a session that no delegation owns, and `ChildSessionJournal.layerNoop` provides it in tests. `continuationPolicy` takes the journal from its context and carries it as `ContinuationPolicy.journal`, which the Claude Code, Codex, and Pi adapters save through.

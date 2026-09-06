---
"@usine/server": minor
"@usine/engine": minor
---

Add `usine export-run <runId>` to save one Run's detail, Attempt history, and complete transcripts as a local JSON file. Use `--output <path>` to choose the destination. Existing files are preserved, and missing Runs or export failures return a nonzero exit status.

Add `RunReader.evidence(runId)` for a consistent snapshot and complete transcripts from one transaction, and `runReaderLayer(instanceDirectory)` for read-only access to an existing local runtime database without migrations.

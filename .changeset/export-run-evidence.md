---
"@usine/server": minor
---

Add `usine export-run <runId>` to save one Run's detail, Attempt history, and complete transcripts as a local JSON file. Use `--output <path>` to choose the destination. Existing files are preserved, and missing Runs or export failures return a nonzero exit status.

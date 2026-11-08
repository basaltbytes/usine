---
"@usine/github": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

Refresh older open pull request payloads once to record comparison bases. Omit attempts without new commits, show checks and review decisions only for whole-PR comparisons, and keep file names readable on phones.

Use `scope` for the file-selection query parameter. Return specific 404 errors for unavailable comparisons and 409 errors for stale PR selections. Bound cached file responses to 512 KiB per entry and 64 MiB of serialized payloads, document the conservative 300-file comparison limit, and export file-change models separately from the GitHub service.

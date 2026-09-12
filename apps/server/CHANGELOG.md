# @usine/server

## 0.2.0

### Minor Changes

- 8b6718d: Make Run conversations easier to follow with expandable tool activity, readable commands and file changes, live session status, transcript filters, and scrolling that preserves the reader’s position. Move Task, Event, and Attempt details into separate tabs. Use AI Elements for tool panels, syntax-highlighted source, and terminal output; keep complete tool payloads available under Raw details.
- 388e59d: Add `usine export-run <runId>` to save one Run's detail, Attempt history, and complete transcripts as a local JSON file. Use `--output <path>` to choose the destination. Existing files are preserved, and missing Runs or export failures return a nonzero exit status.
  
  Add `RunReader.evidence(runId)` for a consistent snapshot and complete transcripts from one transaction, and `runReaderLayer(instanceDirectory)` for read-only access to an existing local runtime database without migrations.
- 83edd04: Add `usine backup <path>` to copy the runtime database while the orchestrator runs. Backups include all tables and committed WAL data, preserve existing destination files, and support restoring Run evidence. Document backup and restore requirements.
- aeb587f: Group adjacent completed tools into expandable summaries, keep tool and child-session choices across conversation filters, and show the active command or file with elapsed time and recent activity. File edits show their patch before confirmation and metadata.
- ef9fd20: Show new conversation updates while reading earlier activity, without counting tool results twice or treating older history as new. Jump to the latest conversation or navigate directly to errors, automatically revealing their tool output and child session.

### Patch Changes

- ffc26c9: Describe completed Run tool groups with compact action summaries, including file names and recognized test or build invocations. Distinguish shared file names, count distinct recorded file paths, and update summaries as earlier inputs load. Keep each tool's result available in its expandable details.
- 162b323: Record executor defects as non-retryable Attempt failures with safe operator messages. Keep Attempt admission and cleanup in one service operation, and match Task relationships by canonical PR paths.
- c7c8a79: Simplify expanded Run tools with flat disclosure rows and indented details. Code, terminal output, and diffs retain distinct panels with copy controls.
- 5c47dc2: Drain admitted Attempts on SIGINT or SIGTERM before closing the runtime. Defer queued work and automatic retries until restart, with a bounded shutdown wait and a second-signal force stop.
- f4f5938: Keep failed commands inside adjacent activity groups, show the group's error count, and let error navigation reopen collapsed groups and child activity to reveal the original failure details.
- a36f46e: Bound issue and pull-request feedback cycles across Runs with `max_cycles` (default three per Loop). Persist Item-level exhaustion Asks, expose explicit resets in the operator UI and HTTP API, and require fresh trigger evaluation after a reset. Upgrade existing Run history and queued Events into the budget.
  
  Use comment reviews and Loop-defined outcome labels for agents sharing a GitHub App identity. Required independent approvals and merging remain operator actions.
- f42d393: Publish the operator HTTP contract at `@usine/orchestrator/operator/http` and derive server handlers and browser requests from it. Preserve existing URLs, response envelopes, transcript query conventions, and operator actions while validating transport failures for typed clients.
- 354e598: Provision factory-wide GitHub label declarations before polling, report non-blocking preflight failures, and warn when Board lanes or Loop triggers use undeclared labels. Label names follow GitHub's contract (at most 50 characters, no surrounding whitespace), and provisioning waits for a confirmed catalog instead of creating labels blindly after a failed catalog request.
- 7cf4887: Refresh Board moves from GitHub promptly and evaluate their Loops without waiting for the next periodic poll. Coalesce self-write Hints, preserve normal polling and Event deduplication, and honor GitHub request backoff.
  
  Keep moved cards in their destination through stale refreshes and project navigation, show saving and synchronization progress, and keep every Board lane reachable beside the sidebar.
- 28ec315: Support Codex CLI 0.153.4 and gracefully stop Codex child processes before completing their sessions, including background commands left alive by turn interruption.
- 6b53a10: Reduce visual noise in Run tool activity with indented groups, aligned hover backgrounds, fewer separators, and implicit success. Replace file-read offset and limit fields with a compact line-range cue beside the source.
- dd81b60: Make proposed Board lanes read-only to preserve descriptive GitHub labels. Configure an authored lane map in usine.yaml to enable moves; authored moves exchange only labels in that map.
- 2cfd65b: Serve the web application shell for direct browser requests to client-side routes while preserving 404 responses for unknown API routes and missing static files.
- b628897: Join linked issue and PR Items into Board tasks with complete saved Run histories, per-task Run and Attempt counts, and explicit current-Item lane moves.
- 580a873: Remember each Run conversation’s filter, inspected disclosures and reading place across drawer closes and page refreshes. Preserve unread activity while restoring earlier history, and resume following for readers who left at latest.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [f42d393]
- Updated dependencies [333eacd]
- Updated dependencies [485f244]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [dd81b60]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/orchestrator@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- 16e7212: Add per-repository Board lane maps, durable projections of GitHub Items and repository labels from polling, live Run data on Board cards, quarantined Item diagnostics, and lane-scoped label moves through the operator API.
- 24eef02: Add CLI port overrides, help and version output, occupied-port diagnostics, and a two-second timeout when `usine up` opens the setup page. The operator API now returns attempts, needs, and transcript events without exposing infrastructure causes. Cold and live transcript reads have explicit response limits, and the web drawer can continue loading rows beyond its initial 500-row page. Concurrent overview requests reuse one projection computation, and local-worker polling budgets include their timing rationale.
- ae86c6c: Add `usine up` with a local observe-and-intervene UI. Persist Loop pause state in the runtime database; list every open Run plus the newest settled ones and project protocol transcripts; expose approve, retry, cancel, pause, and unpause through the embeddable orchestrator; and preserve durable observation while the foreground server waits for missing GitHub App credentials with trigger execution idle.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [24eef02]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [05937b8]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/orchestrator@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0

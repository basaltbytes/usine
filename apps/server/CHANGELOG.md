# @usine/server

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/orchestrator@0.2.1
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 8b6718d: Reworks the run conversation with expandable tool activity, live session status, transcript filters, and scrolling that keeps your position, and moves task, event, and attempt details to separate tabs.
- 388e59d: Adds `usine export-run <runId>`, which saves a run's detail, attempts, and transcripts to a new JSON file (set the path with `--output <path>`). Adds `RunReader.evidence(runId)` and the read-only `runReaderLayer(instanceDirectory)`.
- 83edd04: Adds `usine backup <path>`, which copies the runtime database, including committed WAL data, while the orchestrator runs, and never overwrites an existing file.
- aeb587f: Groups adjacent completed tools into expandable summaries and shows the active command or file with its elapsed time. File edits show their patch first.
- ef9fd20: Shows new conversation updates while you read earlier activity, and adds jumps to the latest message and to errors.

### Patch Changes

- ffc26c9: Completed tool groups show compact action summaries with file names and recognized test or build commands.
- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- c7c8a79: Expanded run tools use flat disclosure rows; code, terminal output, and diffs keep separate panels with copy controls.
- 5c47dc2: On SIGINT or SIGTERM, the orchestrator drains admitted attempts and defers queued work and retries until restart; a second signal forces a stop.
- f4f5938: Failed commands stay in their activity group, which shows an error count, and error navigation opens collapsed groups to show the failure.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- f42d393: Publishes the operator HTTP contract at `@usine/orchestrator/operator/http`; URLs, responses, and operator actions don't change.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- 28ec315: Supports Codex CLI 0.153.4 and stops Codex child processes, including leftover background commands, before their sessions complete.
- 6b53a10: Simplifies run tool activity with indented groups and fewer separators, and file reads show a line range instead of offset and limit fields.
- dd81b60: Proposed board lanes are read-only. To enable moves, configure a lane map in `usine.yaml`; moves exchange only its labels.
- 2cfd65b: Serves the web app for direct requests to client-side routes, and still returns 404 for unknown API routes and missing static files.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
- 580a873: Each run conversation remembers its filter, open disclosures, and reading position across drawer closes and page refreshes.
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

- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.

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

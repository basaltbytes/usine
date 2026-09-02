# @usine/server

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

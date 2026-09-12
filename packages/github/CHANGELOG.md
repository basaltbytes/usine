# @usine/github

## 0.1.1

### Patch Changes

- b9e38a7: Import expression schemas, environment descriptors, and typed errors from
  `@usine/expression/expression-engine`. This replaces the `/model` entry point;
  update existing `/model` imports to `/expression-engine`.
  
  Organize GitHub authentication, access, polling, and operator view contracts by
  responsibility while preserving their existing public entry points and schemas.
- 354e598: Provision factory-wide GitHub label declarations before polling, report non-blocking preflight failures, and warn when Board lanes or Loop triggers use undeclared labels. Label names follow GitHub's contract (at most 50 characters, no surrounding whitespace), and provisioning waits for a confirmed catalog instead of creating labels blindly after a failed catalog request.
- 7cf4887: Refresh Board moves from GitHub promptly and evaluate their Loops without waiting for the next periodic poll. Coalesce self-write Hints, preserve normal polling and Event deduplication, and honor GitHub request backoff.
  
  Keep moved cards in their destination through stale refreshes and project navigation, show saving and synchronization progress, and keep every Board lane reachable beside the sidebar.
- 4c97cae: Accept valid installation tokens when GitHub's clock is slightly ahead, without extending the local lease beyond one hour.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [333eacd]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0

## 0.1.0

### Minor Changes

- 16e7212: Add per-repository Board lane maps, durable projections of GitHub Items and repository labels from polling, live Run data on Board cards, quarantined Item diagnostics, and lane-scoped label moves through the operator API.
- 57d383b: Add a shared GitHub repository identity and implement GitHub App authentication, installation discovery, per-project installation coverage, 0600 local credential loading, and one-repository worker tokens.
- 1a9669d: Persist efficiency-only trigger cursors in the run database. Detect GitHub issue and pull-request changes with conditional REST polling, fetch and content-hash fixed GraphQL payload slices, and turn matching loop state into durable Events through the orchestrator polling service.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.

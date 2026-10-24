# @usine/github

## 0.2.0

### Minor Changes

- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- cef956c: Adds `GitHubItemHistory.appChanges(repository, item, since)` to `@usine/github/item-history`, which returns the App's label changes, comments, and reviews on an item as `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed`; `Installation` adds `appSlug`. `Operator.githubChanges(runId)` returns each attempt's changes as `RunGitHubChangesView` at `GET /api/runs/:runId/github-changes`, which returns 404 `GitHubItemNotFoundError` for an item that GitHub no longer has.
  
  The run page shows each label change, comment, and review that an agent made on the item where it happened.

### Patch Changes

- ca2e7a5: `GitHubApp` errors include GitHub's reason, and `isRefusal` tells a definite refusal from an unsent request, server error, or rate limit.
- 291d428: Adds `GitHubPolling.missingIssues(repository, numbers)`: the issue numbers GitHub no longer has, 50 per GraphQL request.
- 564449d: An open pull request or failing item that GitHub no longer has no longer stops its repository's poll. The poll logs a warning, drops the item from the cursor, and revokes its unstarted runs; `GitHubPolling.snapshot` fails with `GitHubItemNotFoundError`, exported from `@usine/github/polling`, when the item is missing or GraphQL reports `NOT_FOUND`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [af28e0e]
- Updated dependencies [759db71]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5870baf]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [6764fa7]
- Updated dependencies [466e711]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [d933ab6]
- Updated dependencies [a3a230c]
  - @usine/core@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.1.1

### Patch Changes

- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- 4c97cae: Accepts installation tokens when GitHub's clock is slightly ahead, without extending the local lease past one hour.
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

- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 57d383b: Adds GitHub App authentication, installation discovery, per-project installation coverage, local credential loading (mode 0600), and single-repository worker tokens.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.

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

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.

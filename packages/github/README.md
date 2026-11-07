# @usine/github

Gives a usine factory one GitHub App identity. It signs App JWTs, finds the App's installation, reports registry repos that the installation doesn't cover, and mints two kinds of installation token:

- an installation-wide token for orchestrator polling and writes;
- a token for one repo, for a worker attempt.

Both tokens have a one-hour maximum lifetime. Expiry validation tolerates three minutes of clock skew and caps the local lease at one hour; expired tokens are rejected. Token values and the private key stay in Effect `Redacted` values.

Import `GitHubApp`, credentials, access results, and typed App errors from `@usine/github/github-app`. `/polling` provides `GitHubPolling` with its cursors, change-detection results, and payload snapshots, plus `RepositoryLabel`, `RepositoryLabelCatalog`, and `RepositoryLabelsNotModified` for label catalogs and conditional responses. Item and label writes use `/item-writer` and `/label-writer`, the App's own changes on an item come from `/item-history`, and local credential loading uses `/local-secrets`.

The 0.x APIs can change between minor releases.

## Set up the App

[Quickstart](https://docs.usine.dev/get-started/quickstart/) gives the steps under Connect a GitHub App: an App installable only on your account, with an active webhook for deliveries mode, with Contents, Issues, Pull requests, and Workflows read and write, Checks and Metadata read-only, optionally Actions read-only for CI job logs, and **No access** for everything else, including Administration and all organization and account permissions.

GitHub grants Metadata read access automatically. Contents lets installation tokens use Git over HTTPS; Workflows lets write-access attempts push changes under `.github/workflows/`. For an existing App, enable **Workflows: read and write** in its repository permissions and accept the permission update on its installation. Installation checks report `workflows:write` when that grant is missing. User authorization isn't required. Install the App once, on the account that owns the managed repos, for every repo in `usine.yaml`; a factory expects one installation. GitHub's references are [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

Store the App ID and private key in `<instance>/.usine/github-app.json` with mode `0600`, and keep `.usine/` in the instance repo's `.gitignore`:

```json
{
  "app_id": 123456,
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

`USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY` override the matching fields. If both are set, the loader doesn't read the file.

## Compose the services

The package root has no Node dependency. Supply an HTTP client and platform file and path layers at the edge:

```ts
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { InstanceDirectory } from "@usine/core/instance"
import { GitHubApp } from "@usine/github/github-app"
import { localSecretsLayer } from "@usine/github/local-secrets"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const instance = InstanceDirectory.make("/path/to/instance")
const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const credentialsLayer = localSecretsLayer(instance).pipe(
  Layer.provide(platformLayer),
)

export const githubLayer = GitHubApp.layer.pipe(
  Layer.provide(credentialsLayer),
  Layer.provide(FetchHttpClient.layer),
)
```

Operations without arguments are Effect values: use `yield* app.installation`, `yield* app.installationToken`, `yield* app.botAccount`, `yield* app.repositories`, or `yield* app.installationUrl`. These values run when yielded.

`GitHubApp.layer` imports the private key once, at build time, so a key that WebCrypto can't import fails composition with `AppAuthenticationError`, not the first request. Another credential source provides `GitHubCredentials` with `AppCredentials` whose key went through the `RedactedPrivateKey` schema.

`installation`, `installationToken`, and `projectAccess(registry)` share one lease: one installation discovery and installation-wide mint, reused until five minutes before expiry, so polling makes no App requests between renewals. `workerToken()` mints on every call, so each attempt gets its own token.

`botAccount` returns the App's bot account, `<slug>[bot]` and its user ID, which differs from the App ID. It reads `GET /users/<slug>[bot]` with the installation-wide token once per slug. Commits use the account's ID-based noreply address, `<id>+<slug>[bot]@users.noreply.github.com`.

Call `GitHubApp.projectAccess(registry)` before scheduling. Each result is a `CoveredProject`, with the repo ID for scoped minting, or a `ProjectNotInstalledError`. A missing repo doesn't block covered ones.

Pass a `CoveredProject` and the attempt's loop permission level to `GitHubApp.workerToken`. If GitHub's response doesn't confirm that the token covers exactly that repo ID, it fails with `InvalidGitHubResponseError`. `WORKER_TOKEN_PERMISSIONS` lists each level's permissions: a `write` token includes `contents: write` and `workflows: write`, so it can push code and workflow files. A `read` token has `contents: read` and omits `workflows`, so it can't push, and keeps `pull_requests: write` and `issues: write` for reviews and comments.

## Poll repository changes

`GitHubPollingLayer` provides:

- `changes(repository, cursor)`: one conditional Issues REST request, returning changed issue and pull request numbers, the next ETag and watermark, and any rate-limit delay.
- `labels(repository)`: every page of the repo's label catalog, for board lane proposals.
- `baseRefHead(repository, baseRefName, known)`: the head commit of a base branch, from one conditional Git refs REST request with the ETag of `known`. A 304 returns `known` and costs no rate limit; a missing branch fails with a 404 `GitHubApiError`.
- `snapshot(repository, item)`: the issue or pull request payload through GraphQL, with its SHA-256 content hash. The stored payload keeps timestamps; the hash excludes timestamp fields at every level.
- `missingIssues(repository, numbers)`: the numbers the repo no longer has, deleted or transferred. It sends one GraphQL request per 50 numbers, with an aliased `issue(number:)` field each; an issue that returns null is missing.

Snapshots expose `labelEvents[labelName]` for each current label with available history:
`actor.login`, `actor.type` (such as `Bot` or `User`), and `createdAt`. App actors use
the App slug without `[bot]`; deleted actors are null. Missing history has no map
entry. The initial GraphQL query reads the last 100 label additions. Polling reads
older pages until it finds the current labels, with a ten-page limit. At that limit,
the snapshot keeps the events found and omits labels whose history is unavailable.
Older stored payloads decode with an empty map. Actor changes affect the content
hash; timestamp-only changes do not.

Polling REST reads and GraphQL queries retry HTTP 502, 503, and 504 responses and GraphQL server errors up to twice. Delays are approximately one and three seconds, with 20% jitter. Each retry logs a warning with the operation, error tag, retry number, and delay. HTTP failures also include the response status. Other HTTP errors and invalid payloads return immediately; rate-limit responses retain their existing backoff.

GraphQL `NOT_FOUND` errors leave null fields for decoding and do not prevent retries of server errors in the same response. Permission and validation errors fail immediately, including in mixed responses.

Change detection separates `nextPollAt`, the earliest next conditional poll, from `backoffUntil`, a delay from `Retry-After` or rate-limit pressure. Self-write hints can fetch a snapshot within the poll interval while respecting backoff.

The REST cursor overlaps its watermark by five seconds. Repeated items are expected; the engine's event ledger deduplicates. Provide `GitHubPollingLayer` with `GitHubApp`, an Effect HTTP client, and `Crypto.Crypto`.

`GitHubItemWriter.updateLabels(repository, item, mutation)` adds the destination lane's labels and removes only labels that lanes own. It never replaces an item's whole label set or deletes label definitions, so unrelated and concurrent labels survive stale or truncated projections.

`GitHubItemHistory.appChanges(repository, item, since, actor)` (`/item-history`) reads an issue or pull request timeline through GraphQL from `since`, and returns the supplied bot's changes, oldest first: `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed` (a submitted review with its state). Each change has GitHub's time; a label has its current name, color, and description, and comments and reviews have their URL. Other users and bots are left out. Pass the worker's `BotLogin`, including `[bot]`; the reader matches GraphQL's `Bot` actor after removing that REST suffix. The caller selects the writer, so exe.dev attempts can use their integration bot while local, SSH, provisioned, and Cloudflare attempts use the instance App. It reads up to ten pages of 100 items and fails with `InvalidGitHubResponseError` rather than return part of a longer timeline. An item the repo no longer has fails with `GitHubItemNotFoundError`.

`GitHubLabelWriter.create(repository, label)` creates a label through `POST /repos/{owner}/{repo}/labels` with the installation-wide token. Color and description are optional. The orchestrator owns reconciliation, so this service only creates.

The item writer, item history, and label writer each need `GitHubApp` and an Effect HTTP client.

## Real-App integration test

Run the opt-in test against a disposable issue in a repo the App covers:

```sh
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
export USINE_GITHUB_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_ISSUE_NUMBER=123
export 'USINE_GITHUB_INTEGRATION_BOT_LOGIN=your-app-slug[bot]'
pnpm --filter @usine/github test:integration
```

It mints both token kinds, posts an issue comment with the repo token, checks the author against `<app>[bot]`, and deletes the comment at cleanup. `@usine/orchestrator` has a separate live polling test that creates and applies a repo label.

`GitHubApp.repositories` lists the repository names accessible to the GitHub App installation, following every page. Configuration pickers can compare these names with the registry before offering a repository to add.

## Webhook delivery summaries

`GitHubApp.deliveries(after)` uses the App JWT to read new summaries from `GET /app/hook/deliveries`. Pass the last recorded `WebhookDeliveryId`, or `Option.none()` on the first read. Each `WebhookDelivery` contains its ID, event, and optional repository ID. `WebhookDeliveryId` is a branded decimal string that preserves 64-bit IDs exactly; construct it with `WebhookDeliveryId.make("3851199271760044123")` and compare IDs with `BigInt`. Summary decoding reads the original JSON number token through the standard JSON reviver source context, supported by Node 22 and newer. The adapter follows pagination until it reaches the recorded ID, the end of the log, or ten pages. It fetches no delivery payloads.

Enable the App webhook to record deliveries. A delivery with a failed HTTP status can still request a refresh; no reachable webhook endpoint is needed for deliveries mode.

`GitHubApp.configureWebhook(url)` uses the App JWT to PATCH `/app/hook/config` with the full delivery URL and JSON content type. It preserves the App's webhook secret, active flag, and subscribed events. Enable the webhook in the App settings before using endpoint mode.

## Setup credentials

`GitHubApp.installationUrl` returns the App's installation page, including before its first installation. It reads the authenticated App metadata and uses the same typed errors as other App requests.

`@usine/github/local-secrets` accepts optional `client_id`, `client_secret`, and `webhook_secret` fields alongside `app_id` and `private_key`. `loadLocalSecrets` returns `None` for an absent file and rejects invalid contents or permissions. `writeLocalSecrets` atomically replaces the runtime file with mode 0600; credential values remain redacted in memory. Legacy files with only the App ID and private key continue to load.

## CI checks

`GitHubChecks` from `/checks` reads the source branch head and the PR's aggregate check state. When the PR head lags behind its branch, the snapshot reports the branch head as pending and logs both SHAs. Checks and mergeability apply once the PR head matches its branch. When checks are absent and GitHub reports `CONFLICTING`, the snapshot state is `conflict`. Missing checks otherwise stay pending, including while mergeability is `UNKNOWN`. Failure diagnostics include failed check and step names and up to 12,000 characters from four Actions jobs. The excerpt reads numbered step files when available, or separates the archive's combined job log with step timestamps and matching runner headers. It keeps context around failure markers plus each failed step's final output. When combined step boundaries are ambiguous, diagnostics use the check output. Legacy commit statuses provide their context and description. Grant the App **Actions: read-only** to read job logs. Without this optional permission, diagnostics use the check output. CI REST reads, including check runs, commit statuses, job metadata, and log archives, use the same bounded retry policy as polling reads. Rate limits propagate to the caller's polling backoff. `GitHubChecks.layer` needs `GitHubApp` and an Effect HTTP client.

`ItemLabelMutation.add` and `remove` can each be empty. Removal-only actions send no additions request, and repeated removals ignore missing labels.

## Schema contracts

GitHub response records and errors use nominal Schema brands. Use their schema constructors for typed values, and decode external responses with `Schema.decodeUnknownEffect`.

Run `pnpm --filter @usine/github check` after building dependencies to check TypeScript and Effect diagnostics with the patched compiler.

## CI failure evidence

`GitHubChecks` reads the pull request head and aggregate check state. For failed Actions jobs, it extracts bounded failed-step logs from the run-attempt archive. If the archive is unavailable or lacks the failed step, it reads the completed job's plain log, including when other matrix jobs are running. Rate limits defer polling; unavailable job logs use the check output.

## Pull request files

`GitHubFiles` from `/files` reads changed files with the installation token, bounded transient retries, and typed rate-limit errors. `read(repository, item, selection)` accepts `PullRequestFilesQuery` or `CommitRangeFilesQuery`, each with `base` and `head` commit SHAs. Attempt comparisons use the recorded checkout base and pushed head.

PR reads follow up to 30 pages of 100 files and verify the selected head and base before and after pagination. Comparisons report GitHub's 300-file limit. Missing patches use `kind: "omitted"`; incomplete text patches have `truncated: true`. Paths identify test and generated files. Successful responses are cached by repository, PR, and commit selection without expiration, in a shared 128-entry cache. Failures are retried on the next read. `GitHubFiles.layer` requires `GitHubApp` and an Effect HTTP client.

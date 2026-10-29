# @usine/github

Gives a usine factory one GitHub App identity. It signs App JWTs, finds the App's installation, reports registry repos that the installation doesn't cover, and mints two kinds of installation token:

- an installation-wide token for orchestrator polling and writes;
- a token for one repo, for a worker attempt.

Both tokens have a one-hour maximum lifetime. Expiry validation tolerates three minutes of clock skew and caps the local lease at one hour; expired tokens are rejected. Token values and the private key stay in Effect `Redacted` values.

Import `GitHubApp`, credentials, access results, and typed App errors from `@usine/github/github-app`. `/polling` provides `GitHubPolling` with its cursors, change-detection results, and payload snapshots, plus `RepositoryLabel`, `RepositoryLabelCatalog`, and `RepositoryLabelsNotModified` for label catalogs and conditional responses. Item and label writes use `/item-writer` and `/label-writer`, the App's own changes on an item come from `/item-history`, and local credential loading uses `/local-secrets`.

The 0.x APIs can change between minor releases.

## Set up the App

[Run a factory](https://docs.usine.dev/guides/) gives the steps under Connect a GitHub App: an App installable only on your account, without active webhooks, with Contents, Issues, and Pull requests read and write, Checks and Metadata read-only, and **No access** for everything else, including Workflows, Administration, and all organization and account permissions.

GitHub grants Metadata read access automatically. Contents lets installation tokens use Git over HTTPS; with Workflows off, worker tokens can't edit `.github/workflows/`. User authorization isn't required. Install the App once, on the account that owns the managed repos, for every repo in `usine.yaml`; a factory expects one installation. GitHub's references are [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

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

`GitHubApp.layer` imports the private key once, at build time, so a key that WebCrypto can't import fails composition with `AppAuthenticationError`, not the first request. Another credential source provides `GitHubCredentials` with `AppCredentials` whose key went through the `RedactedPrivateKey` schema.

`installation()`, `installationToken()`, and `projectAccess()` share one lease: one installation discovery and installation-wide mint, reused until five minutes before expiry, so polling makes no App requests between renewals. `workerToken()` mints on every call, so each attempt gets its own token.

`botAccount()` returns the App's bot account, `<slug>[bot]` and its user ID, which differs from the App ID. It reads `GET /users/<slug>[bot]` with the installation-wide token once per slug. Commits use the account's ID-based noreply address, `<id>+<slug>[bot]@users.noreply.github.com`.

Call `GitHubApp.projectAccess(registry)` before scheduling. Each result is a `CoveredProject`, with the repo ID for scoped minting, or a `ProjectNotInstalledError`. A missing repo doesn't block covered ones.

Pass a `CoveredProject` and the attempt's loop permission level to `GitHubApp.workerToken`. If GitHub's response doesn't confirm that the token covers exactly that repo ID, it fails with `InvalidGitHubResponseError`. `WORKER_TOKEN_PERMISSIONS` lists each level's permissions: a `read` token has `contents: read`, so it can't push, and keeps `pull_requests: write` and `issues: write` for reviews and comments.

## Poll repository changes

`GitHubPollingLayer` provides:

- `changes(repository, cursor)`: one conditional Issues REST request, returning changed issue and pull request numbers, the next ETag and watermark, and any rate-limit delay.
- `labels(repository)`: every page of the repo's label catalog, for board lane proposals.
- `baseRefHead(repository, baseRefName, known)`: the head commit of a base branch, from one conditional Git refs REST request with the ETag of `known`. A 304 returns `known` and costs no rate limit; a missing branch fails with a 404 `GitHubApiError`.
- `snapshot(repository, item)`: the issue or pull request payload through GraphQL, with its SHA-256 content hash. The stored payload keeps timestamps; the hash excludes timestamp fields at every level.
- `missingIssues(repository, numbers)`: the numbers the repo no longer has, deleted or transferred. It sends one GraphQL request per 50 numbers, with an aliased `issue(number:)` field each; an issue that returns null is missing.

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

`GitHubApp.repositories()` lists the repository names accessible to the GitHub App installation, following every page. Configuration pickers can compare these names with the registry before offering a repository to add.

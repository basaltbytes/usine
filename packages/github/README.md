# @usine/github

`@usine/github` gives an usine factory one GitHub App identity. It signs App JWTs, finds the App's installation, reports registry repositories that the installation does not cover, and mints two kinds of installation token:

- an installation-wide token for orchestrator polling and writes;
- a token restricted to one repository for a worker attempt.

Both token requests use a one-hour maximum lifetime. Token values and the App private key stay inside Effect `Redacted` values.

## Create the App manually

Open your GitHub account or organization settings, select **Developer settings → GitHub Apps**, then select **New GitHub App**. Use a name that identifies the factory and set **Where can this GitHub App be installed?** to **Only on this account**. User authorization isn't required. You can turn off active webhooks for a polling-only development factory.

Set these repository permissions:

| Permission | Access |
| --- | --- |
| Metadata | Read-only |
| Contents | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Checks | Read-only |

Leave Workflows, Administration, every organization permission, and every account permission at **No access**. GitHub grants Metadata read access automatically. The Contents permission lets installation tokens authenticate Git over HTTPS; Workflows remains off, so worker tokens cannot edit files under `.github/workflows/`.

Create the App, generate a private key, and note the numeric App ID. On the App's **Install App** page, install it on the account that owns the factory's managed repositories. Select every repository listed in `usine.yaml`. A factory expects one App installation, so don't install the same App on a second account.

GitHub's current setup references are [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app) and [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## Store the credentials

The local runtime file is `<instance>/.usine/github-app.json`. Keep `.usine/` in the instance repo's `.gitignore`, and set the file mode to `0600`.

```json
{
  "app_id": 123456,
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

This command creates the JSON without copying PEM newlines by hand:

```sh
mkdir -p .usine
install -m 600 /dev/null .usine/github-app.json
jq -n --argjson app_id "$APP_ID" --rawfile private_key factory.private-key.pem \
  '{app_id: $app_id, private_key: $private_key}' > .usine/github-app.json
```

`USINE_GITHUB_APP_ID` and `USINE_GITHUB_PRIVATE_KEY` override their matching file fields. When both variables exist, the loader does not read the file.

## Compose the services

The package root has no Node dependency. Supply an HTTP client plus platform file and path layers at the application edge:

```ts
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { InstanceDirectory } from "@usine/core/instance"
import { GitHubApp } from "@usine/github/github-app"
import { localSecretsLayer } from "@usine/github/local-secrets"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

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

`GitHubApp.layer` imports the private key once, when the layer is built: a key WebCrypto cannot import fails composition with `AppAuthenticationError` instead of failing the first request. Another credential source provides `GitHubCredentials` with an `AppCredentials` whose key went through the `RedactedPrivateKey` schema.

`installation()`, `installationToken()`, and `projectAccess()` share one lease: a single installation discovery and installation-wide mint, reused until five minutes before the token expires. Polling therefore costs no App requests between renewals. `workerToken()` mints on every call, so each attempt gets its own token.

Call `GitHubApp.projectAccess(registry)` before scheduling work. Each result is either a `CoveredProject`, which carries the repository ID needed for scoped minting, or a `ProjectNotInstalledError`. A missing repository does not block covered projects.

Pass a `CoveredProject` to `GitHubApp.workerToken`. GitHub must confirm in the token response that the token covers exactly that repository ID; otherwise the call fails with `InvalidGitHubResponseError`.

## Poll repository changes

`GitHubPollingLayer` supplies the operations the orchestrator needs:

- `changes(repository, cursor)` makes one conditional Issues REST request. It returns changed issue and pull-request numbers, the next ETag and watermark, plus any rate-limit delay GitHub requested.
- `labels(repository)` reads every page of the repository label catalog for Board lane proposals.
- `snapshot(repository, item)` fetches the issue or pull-request payload through GraphQL and computes its SHA-256 content hash. The stored payload retains timestamps, while the hash excludes timestamp fields at every nesting level.

The REST cursor overlaps its watermark by five seconds. Repeated items are expected; the engine's permanent Event ledger owns deduplication. Provide `GitHubPollingLayer` with `GitHubApp`, an Effect HTTP client, and `Crypto.Crypto`. The package root remains platform-free.

`GitHubItemWriter.updateLabels(repository, item, mutation)` adds destination lane labels and removes only explicitly lane-owned labels from an issue or pull request. It never replaces the complete applied-label set or deletes repository label definitions, so unrelated and concurrently added labels survive stale or truncated Item projections. The service requires `GitHubApp` and an Effect HTTP client.

`GitHubLabelWriter.create(repository, label)` creates one repository label through `POST /repos/{owner}/{repo}/labels` using the installation-wide App token. Provide a name; color and description are optional. Reconciliation policy belongs to the orchestrator, so this service exposes creation only and never edits or deletes label definitions.

## Real-App integration check

Run the opt-in integration test against a disposable issue in a repository covered by the App:

```sh
export USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY=/path/to/instance
export USINE_GITHUB_INTEGRATION_REPO=owner/repo
export USINE_GITHUB_INTEGRATION_ISSUE_NUMBER=123
export 'USINE_GITHUB_INTEGRATION_BOT_LOGIN=your-app-slug[bot]'
pnpm --filter @usine/github test:integration
```

The test mints both token shapes, posts one issue comment with the repository-scoped token, checks the comment author against the expected `<app>[bot]` login, and deletes the comment during cleanup. `@usine/orchestrator` has a separate live polling test that temporarily creates and applies a repository label.

All APIs remain 0.x and can change between minor releases.

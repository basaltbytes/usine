---
walkthrough: 1
title: GitHub App identity and repository-scoped credentials
pr: 50
commit: f632adc8be5d105b27f287dc25d7f96826921d7d
meta:
  pr: "50"
  commit: f632adc8
  scope: "@usine/github"
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="GitHub App identity and scoped access" icon="key" %}
This change turns `@usine/github` from a reserved package seam into the factory's GitHub App identity. The new Effect service signs App JWTs, discovers and validates one installation, checks managed-repo coverage, and mints installation tokens for two trust boundaries: the orchestrator and one worker attempt.

The main review concern is credential scope. The orchestrator can request an installation-wide token. A worker can receive a token only from a `CoveredProject`, and the request uses that project's GitHub repository ID. The adapter also rejects a token response that has a lifetime outside one hour or does not confirm exactly one matching repository. App credentials and token values use `Redacted` wrappers.

The change also moves the validated `owner/name` value object into `@usine/core`, adds a strict local credential adapter, documents manual App setup, and adds an opt-in real-App check.
{% /section %}
{% /group %}

{% group label="GitHub App identity" %}
{% section id="identity-service" title="One service owns discovery and token minting" icon="shield-check" related=["project-coverage","local-credentials"] %}
`GitHubApp` exposes four operations. `installation()` validates App installation state. `installationToken()` returns the orchestrator token. `projectAccess()` resolves each registry entry against the installation. `workerToken()` accepts only the covered-project variant.

{% code file="packages/github/src/github-app.ts" from=93 to=111 expect="export class GitHubApp extends Context.Service<" /%}

The service signs a short App JWT before each App-authenticated request. The signer uses WebCrypto with RS256, backdates `iat` by one minute for clock skew, sets `exp` nine minutes ahead, and returns the JWT as a redacted value. It accepts PKCS#1 and PKCS#8 private-key encodings through the package's platform-free WebCrypto path.

{% code file="packages/github/src/jwt.ts" from=79 to=110 expect="    sign: Effect.fn(\"AppJwtSigner.sign\")(function* (credentials: AppCredentials) {" collapsed=true /%}

Installation discovery requests at most two records because the factory requires exactly one installation. It returns typed errors for no installation, multiple installations, suspension, and missing required permissions. HTTP failures and invalid response bodies also stay in the declared GitHub error channel.

{% code file="packages/github/src/github-app.ts" from=138 to=183 expect="      const discoverInstallation = Effect.fn(\"GitHubApp.discoverInstallation\")(function* () {" collapsed=true /%}

The required permission object is also the body sent for both token shapes. It includes read access for checks and metadata, and write access for contents, issues, and pull requests. It does not request workflow or administration permissions.

{% code file="packages/github/src/model.ts" from=55 to=92 expect="export const REQUIRED_REPOSITORY_PERMISSIONS = {" /%}
{% /section %}

{% section id="project-coverage" title="Coverage isolates registry drift before worker minting" icon="filter" related=["identity-service"] %}
`projectAccess()` first mints an installation-wide token and pages through every repository visible to that installation. It then performs a case-insensitive comparison with the registry. The result keeps registry order and contains one value per managed repo:

- `CoveredProject` carries the installation ID and GitHub repository ID needed for minting.
- `ProjectNotInstalledError` reports drift for only that project. It does not fail covered siblings.

The shared `Repository.Name` value object now lives in `@usine/core`; `@usine/config` aliases it instead of maintaining a second `owner/name` schema.

{% code file="packages/core/src/repository.ts" from=3 to=13 expect="/**" /%}

{% code file="packages/github/src/model.ts" from=94 to=138 expect="export class CoveredProject extends Schema.TaggedClass<CoveredProject>(" /%}

Worker minting sends `repository_ids` with the covered project's single numeric ID. After GitHub responds, the adapter checks both boundaries rather than trusting the request: expiry must be positive and no more than one hour away, and a single-repository response must list exactly one case-insensitive name match.

```pseudo
resolve registry
  discover one valid installation
  mint installation-wide token
  list all installed repositories
  return covered or project-local error per entry

mint worker token
  request one repository ID
  reject expiry outside one hour
  reject zero, multiple, or different repositories
  return redacted single-repository token
```

{% code file="packages/github/src/github-app.ts" from=185 to=242 expect="      const mintToken = Effect.fn(\"GitHubApp.mintToken\")(function* (mint: MintRequest) {" /%}
{% /section %}
{% /group %}

{% group label="Credential custody" %}
{% section id="local-credentials" title="Environment overrides a strict runtime file" icon="lock" related=["identity-service"] %}
The Node-specific local adapter remains behind the `@usine/github/local-secrets` subpath. The package root depends only on abstract `FileSystem`, `Path`, and HTTP services, so application code supplies platform layers at the edge.

The loader reads the App ID and private key independently from environment configuration. If both environment values are valid, it does not access the file. If only one exists, it reads the other field from `<instance>/.usine/github-app.json` and lets the environment field win. File fallback requires a regular file with mode exactly `0600`; JSON decoding rejects extra properties. Read, permission, parse, and environment failures have typed errors.

{% callout tone="key" %}
Credential contents are intentionally omitted from this walkthrough. Review the local-secrets and setup diffs directly when checking the runtime file format and operational handling.
{% /callout %}

{% code file="packages/github/src/local-secrets.ts" from=45 to=124 expect="/**" /%}

The README gives the operator the matching manual procedure: create one account-scoped App, grant only the required repository permissions, install it on all managed repos, secure the runtime file, and compose the platform and HTTP layers.

{% code file="packages/github/README.md" from=52 to=78 expect="## Compose the services" /%}
{% /section %}
{% /group %}

{% group label="Verification" %}
{% section id="verification" title="Scope, drift, custody, and bot identity checks" icon="beaker" related=["project-coverage","local-credentials"] %}
The unit suite uses a generated RSA key and a fake HTTP client. It checks the request bodies and cryptographic signature, not only returned variants. Separate failure scenarios cover GitHub scope mismatch, an excessive token lifetime, permission drift, and adapter defects.

{% tests %}
{% test name="App JWT and both token shapes" kind="unit" ref="packages/github/test/github-app.test.ts" asserts=["verifies the RS256 signature and bounded JWT claims","requests the required permission set without workflows","uses one repository ID for the worker token","keeps returned token values redacted"] %}The fake GitHub API drives installation-wide minting, mixed covered and missing registry entries, and worker minting in one flow.{% /test %}
{% test name="Boundary failures remain typed" kind="unit" ref="packages/github/test/github-app.test.ts" asserts=["rejects a response that confirms multiple repositories","rejects a reported lifetime over one hour","reports missing write permission","translates an HTTP defect into GitHubApiError"] %}These cases verify the response checks and the service error channel.{% /test %}
{% test name="Local credential precedence and permissions" kind="unit" ref="packages/github/test/local-secrets.test.ts" asserts=["loads a 0600 file","allows one environment field to override its file field","skips file access for complete environment credentials","rejects a group-readable file"] %}The tests also check that object stringification does not expose the private key.{% /test %}
{% test name="Operator-created App check" kind="http" ref="packages/github/test/integration/github-app.test.ts" asserts=["mints installation-wide and single-repository tokens","posts with the scoped token","observes the expected bot login","deletes the temporary comment"] %}This opt-in test exercises a real App and disposable issue. It is excluded from the default test command and runs through `test:integration`.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="GitHub identity implementation" only="packages/github/src/**" /%}
{% filegroup label="Tests" only="{packages/github/test/**,packages/core/test/**}" /%}
{% filegroup label="Shared repository model" only="{packages/core/src/**,packages/config/src/model.ts}" /%}
{% filegroup label="Documentation and package setup" only="{packages/github/README.md,packages/core/README.md,packages/github/package.json,packages/github/tsconfig.check.json}" /%}
{% filegroup label="Release and workspace" only="{.changeset/**,pnpm-lock.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}

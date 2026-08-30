---
walkthrough: 1
title: Durable GitHub polling from change detection to Events
pr: 51
commit: 69b5bd6a8ce85382589583ca3e07033fb120719a
meta:
  pr: "#51"
  commit: 69b5bd6
  scope: engine, GitHub, orchestrator
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="From GitHub state to durable work" icon="git-pull-request" %}
This change implements the polling trigger path across three blocks. `@usine/github` detects changed issues and pull requests, fetches fixed payload slices, and hashes stable content. `@usine/orchestrator` applies selectors and CEL expressions, then submits matching snapshots to the durable run engine. `@usine/engine` stores the ETag and watermark cursor beside the permanent Event ledger.

The key review boundary is the split between **efficiency state** and **correctness state**. A missing or invalid cursor causes a cold poll. It does not create duplicate work because the Event dedup key remains permanent in the run database.
{% /section %}
{% /group %}

{% group label="GitHub polling" %}
{% section id="change-detection" title="Conditional change detection" icon="sync" related=["snapshot-hash","event-composition"] %}
`GitHubPolling.changes()` makes one Issues REST request for each watched managed repo. The request includes issues and pull requests, sorts the oldest updates first, limits the response to 100 items, and subtracts five seconds from the stored watermark. The overlap prevents boundary loss; repeated items are safe downstream.

The adapter sends the stored ETag as `If-None-Match`. A `304` keeps the existing cursor. A `200` must include a new ETag, or the adapter returns `InvalidGitHubResponseError`. The new watermark is the latest item timestamp or the previous watermark, whichever is later.

{% code file="packages/github/src/polling/polling.ts" from=152 to=174 expect="const changesUrl = (repository: Repository.Name, cursor: PollCursor): string => {" /%}

{% code file="packages/github/src/polling/polling.ts" from=211 to=249 expect="    const changes = Effect.fn(\"GitHubPolling.changes\")(function* (" /%}

{% callout %}
One cycle reads one page of at most 100 changes. Because the request sorts updates in ascending order and advances to the last item in that page, a larger backlog drains over later cycles rather than through REST pagination in the same cycle. This preserves the one-REST-call-per-interval contract.
{% /callout %}

GitHub delay headers also become control data. The adapter selects the latest deadline from `X-Poll-Interval`, `Retry-After`, and low remaining-rate-limit guidance. A `403` or `429` with retry data becomes the typed `GitHubRateLimitError`.
{% /section %}

{% section id="snapshot-hash" title="Fixed snapshots and timestamp-free hashes" icon="fingerprint" related=["change-detection","event-composition"] %}
A changed item selects one fixed GraphQL query. The issue and pull-request schemas parse the response before it enters the orchestrator. Connection limits and `totalCount` fields are part of these fixed v1 payload slices.

The payload stored in the Event keeps its timestamps. Hashing uses a separate canonical form:

1. Recursively remove `closedAt`, `createdAt`, `mergedAt`, `submittedAt`, and `updatedAt`.
2. Sort every object's keys.
3. Preserve array order and all other values.
4. Encode the result and compute SHA-256.

{% code file="packages/github/src/polling/polling.ts" from=53 to=72 expect="const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([" collapsed=true /%}

The snapshot method rejects a missing repository or item in an otherwise successful GraphQL response. It returns the parsed payload together with the content hash, so callers cannot accidentally hash a different representation.

{% code file="packages/github/src/polling/polling.ts" from=251 to=307 expect="    const graphql = Effect.fn(\"GitHubPolling.graphql\")(function* <" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Trigger composition" %}
{% section id="event-composition" title="Selectors, CEL, Events, and revocation" icon="workflow" related=["change-detection","snapshot-hash","cursor-commit"] %}
The orchestrator first removes schedule loops and loops whose selectors do not include the managed repo. For each changed item, it fetches one snapshot and shares that snapshot across all loops for the item's stream.

```mermaid
flowchart TD
  repo[Watched managed repo] --> rest[Conditional REST poll]
  rest --> item[Changed item]
  item --> graph[GraphQL snapshot]
  graph --> cel{CEL matches?}
  cel -->|yes| event[Submit durable Event]
  cel -->|no| revoke[Revoke unstarted Run]
```

The stable Item key contains GitHub, the lowercase repository name, and the item number. The Event dedup key contains the loop name, lowercase repository name, item number, and content hash. Thus, the same content rejoins the original Run across overlap polls and process restarts. New non-timestamp content creates a new Event. The submitted Event stores the exact payload used for CEL evaluation.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=72 to=139 expect="const canonicalRepository = (repository: string): string => repository.toLowerCase();" /%}

A false CEL result calls `RunEngine.revoke()` for that loop and Item. The engine's existing revoke rule limits this to pending or waiting work; it does not stop a running Attempt.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=200 to=249 expect="      const evaluateItem = Effect.fn(\"PollingTriggers.evaluateItem\")(function* (" /%}
{% /section %}

{% section id="cursor-commit" title="Restart-safe cursor commit" icon="database" related=["event-composition","poll-scheduling"] %}
`CursorStore` adds a JSON-checked `usine_cursors` table and an upsert API to the engine layer. The cursor owner keeps its own schema; the engine only validates the key and JSON boundary.

{% code file="packages/engine/src/cursor/store.ts" from=17 to=55 expect="/** Durable storage for efficiency-only cursors whose schemas stay with their owners. */" /%}

The stored GitHub value contains the ETag/watermark cursor and a sorted set of watch keys. Each watch key covers the loop name, stream, and CEL expression. A missing row, malformed value, added or removed loop, stream change, or expression change resets the repo to an empty cursor and causes a cold poll.

**Cursor advancement is the cycle commit point.** The orchestrator writes the new cursor only after every changed item was fetched, evaluated, and submitted or revoked. Any earlier typed failure leaves the old cursor in place, so the next cycle repeats detection and relies on Event deduplication.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=251 to=281 expect="      const pollRepository = Effect.fn(\"PollingTriggers.pollRepository\")(function* (" /%}
{% /section %}

{% section id="poll-scheduling" title="Factory interval and GitHub delays" icon="clock" related=["cursor-commit"] %}
`PollingTriggers.poll()` processes up to four managed repos concurrently and up to four changed items per repo. It returns cycle counts, submission results, revocations, and the latest GitHub delay across all repos.

`PollingTriggers.run()` repeats that cycle forever. Its next start is no earlier than both the factory-wide `poll_interval` and GitHub's latest recommended deadline. A typed rate-limit failure enters the same delay path instead of ending the polling loop. Other errors remain visible in the service error channel.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=283 to=312 expect="      const poll = Effect.fn(\"PollingTriggers.poll\")(function* (instance: LoadedInstance) {" /%}
{% /section %}
{% /group %}

{% group label="Proof" %}
{% section id="regression-proof" title="Polling and durability scenarios" icon="beaker" related=["snapshot-hash","event-composition","cursor-commit","poll-scheduling"] %}
{% tests %}
{% test name="Conditional REST detection" kind="unit" ref="packages/github/test/polling.test.ts" asserts=["classifies issues and pull requests from one response","sends the restored ETag","uses a five-second watermark overlap","keeps GitHub rate-limit guidance"] %}An injected Effect HTTP client records requests and returns controlled REST responses.{% /test %}
{% test name="Canonical snapshot hashing" kind="unit" ref="packages/github/test/polling.test.ts" asserts=["timestamp-only changes keep the same hash","content changes produce a new hash","issue and pull-request slices parse"] %}Controlled GraphQL payloads prove the distinction between the stored snapshot and its timestamp-free identity.{% /test %}
{% test name="Durable trigger lifecycle" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["cold start submits matching state","overlap polls and restart rejoin the original Run","a new loop resets the cursor","new matching content opens new work","unmatching content revokes waiting work"] %}The test uses real local SQLite, the real CEL adapter, and a fake GitHub polling seam.{% /test %}
{% test name="GitHub delay scheduling" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["a 120-second GitHub deadline overrides a 60-second factory interval"] %}The Effect test clock checks that no second request starts early.{% /test %}
{% test name="Live repository path" kind="tour" ref="packages/orchestrator/test/integration/polling-triggers.test.ts" asserts=["a temporary label change creates an Event within one interval","the Event payload contains the label","an orchestrator restart does not create a second identity"] %}This opt-in check uses configured GitHub App credentials. Credential values are omitted here.{% /test %}
{% test name="Cursor persistence" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["an upsert replaces the old JSON value","a new store layer restores the replacement"] %}A local SQLite database proves persistence across layer reconstruction.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Engine cursor storage" only="packages/engine/**" /%}
{% filegroup label="GitHub polling adapter" only="packages/github/**" /%}
{% filegroup label="Orchestrator composition" only="packages/orchestrator/**" /%}
{% filegroup label="Release metadata" only="{.changeset/**,pnpm-lock.yaml}" /%}
{% /files %}
{% /section %}
{% /group %}

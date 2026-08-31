---
walkthrough: 1
title: Durable GitHub polling from change detection to Events
pr: 51
commit: 1a6e373ec51d861ca92077e378b827025a5131fd
meta:
  pr: "#51"
  commit: 1a6e373
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

The adapter sends the stored ETag as `If-None-Match`. A `304` keeps the existing cursor. A `200` without a parseable ETag degrades to unconditional polling next cycle — the cursor is efficiency-only, so the adapter logs a warning and continues. The new watermark is the latest item timestamp or the previous watermark, whichever is later.

{% code file="packages/github/src/polling/polling.ts" from=125 to=138 expect="const changesUrl = (repository: Repository.Name, cursor: PollCursor): string => {" /%}

{% code file="packages/github/src/polling/polling.ts" from=212 to=269 expect="      const changes = Effect.fn(\"GitHubPolling.changes\")(function* (" /%}

{% callout %}
Steady state stays one conditional REST call per interval. On a backlog, the cycle follows `Link: rel="next"` for up to ten pages, keeps only the first page's ETag (it matches the canonical URL the next cycle re-requests), and reports `backlog: true` with a log line when the cap ends the walk early — the ascending sort and advancing watermark drain the remainder over later cycles.
{% /callout %}

GitHub delay headers also become control data. The adapter selects the latest deadline from `X-Poll-Interval`, `Retry-After`, and low remaining-rate-limit guidance. A `403` or `429` with retry data becomes the typed `GitHubRateLimitError`.
{% /section %}

{% section id="snapshot-hash" title="Fixed snapshots and timestamp-free hashes" icon="fingerprint" related=["change-detection","event-composition"] %}
A changed item selects one fixed GraphQL query. The issue and pull-request schemas parse the response before it enters the orchestrator. Connection limits and `totalCount` fields are part of these fixed v1 payload slices. GitHub declares most connections nullable, so the boundary normalizes a null connection to an empty one — the domain payload stays non-null and both shapes hash to the same Event identity.

The payload stored in the Event keeps its timestamps. Hashing uses a separate canonical form:

1. Recursively remove `closedAt`, `createdAt`, `mergedAt`, `submittedAt`, and `updatedAt`.
2. Sort every object's keys.
3. Preserve array order and all other values.
4. Encode the result and compute SHA-256.

{% code file="packages/github/src/polling/model.ts" from=17 to=23 expect="export const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([" collapsed=true /%}

GraphQL reports failures on HTTP 200, so the adapter reads the `errors` array before decoding data: `RATE_LIMITED` becomes the typed rate-limit wait, and any other messages survive on `InvalidGitHubResponseError.detail`. The snapshot method rejects a null repository or item and returns the parsed payload together with the content hash, so callers cannot accidentally hash a different representation.

{% code file="packages/github/src/polling/polling.ts" from=272 to=316 expect="      const graphql = Effect.fn(\"GitHubPolling.graphql\")(function* <" collapsed=true /%}
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

The stable Item key contains GitHub, the canonical (lowercase, via `Repository.canonical`) repository name, and the item number. The Event dedup key contains the loop name, canonical repository name, item number, and content hash. Thus, the same content rejoins the original Run across overlap polls and process restarts. New non-timestamp content creates a new Event. The submitted Event stores the exact payload used for CEL evaluation.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=80 to=147 expect="const cursorKey = (repository: ManagedRepo): CursorKey =>" /%}

A false CEL result calls `RunEngine.revoke()` for that loop and Item. The engine's existing revoke rule limits this to pending or waiting work; it does not stop a running Attempt. Revoke returns the run ids it actually closed, so the cycle counts real revocations and each submission and revocation leaves a structured log line with the repository, loop, item, and run id.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=195 to=267 expect="      const evaluateItem = Effect.fn(\"PollingTriggers.evaluateItem\")(function* (" /%}
{% /section %}

{% section id="cursor-commit" title="Restart-safe cursor commit" icon="database" related=["event-composition","poll-scheduling"] %}
`CursorStore` adds a JSON-checked `usine_cursors` table and a schema-aware upsert API to the engine layer: the cursor owner passes its own schema per call, and a stored value that no longer decodes reads as absent — logged, never fatal, because losing a cursor is always safe.

{% code file="packages/engine/src/cursor/store.ts" from=21 to=89 expect="export class CursorStore extends Context.Service<" /%}

The stored GitHub value contains the ETag/watermark cursor and a sorted set of watch keys. Each watch key covers the loop name, stream, and CEL expression. A missing row, malformed value, added or removed loop, stream change, or expression change resets the repo to an empty cursor and causes a cold poll.

**Cursor advancement is the cycle commit point.** The orchestrator writes the new cursor only after every changed item was fetched, evaluated, and submitted or revoked. Any earlier typed failure leaves the old cursor in place, so the next cycle repeats detection and relies on Event deduplication.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=269 to=307 expect="      const pollRepository = Effect.fn(\"PollingTriggers.pollRepository\")(function* (" /%}
{% /section %}

{% section id="poll-scheduling" title="Failure isolation, factory interval, and GitHub delays" icon="clock" related=["cursor-commit"] %}
`PollingTriggers.poll()` processes up to four managed repos concurrently and up to four changed items per repo. Each repository's cycle is isolated with `Effect.result`: a typed failure in one repo is logged and reported on the `PollCycle` while its siblings finish, a rate-limit error becomes scheduling input instead of a failure, and only a defect can stop the loop. The service error channel is empty — `poll` always returns its cycle.

`PollingTriggers.run()` repeats that cycle forever, logging one structured summary per cycle (repositories, changed items, submissions, revoked runs, failures, sleep). Its next start is no earlier than both the factory-wide `poll_interval` and GitHub's latest recommended deadline. `run` deliberately has no named span of its own — it never returns, so each cycle's span lives on `poll`.

{% code file="packages/orchestrator/src/polling-triggers.ts" from=309 to=361 expect="      const poll = Effect.fn(\"PollingTriggers.poll\")(function* (instance: LoadedInstance) {" /%}

{% code file="packages/orchestrator/src/polling-triggers.ts" from=364 to=384 expect="      const run = (instance: LoadedInstance): Effect.Effect<never> =>" collapsed=true /%}
{% /section %}
{% /group %}

{% group label="Proof" %}
{% section id="regression-proof" title="Polling and durability scenarios" icon="beaker" related=["snapshot-hash","event-composition","cursor-commit","poll-scheduling"] %}
{% tests %}
{% test name="Conditional REST detection" kind="unit" ref="packages/github/test/polling.test.ts" asserts=["classifies issues and pull requests from one response","sends the restored ETag","uses a five-second watermark overlap","keeps GitHub rate-limit guidance","continues without an ETag","walks Link pagination within one cycle"] %}An injected Effect HTTP client records requests and returns controlled REST responses.{% /test %}
{% test name="Canonical snapshot hashing" kind="unit" ref="packages/github/test/polling.test.ts" asserts=["timestamp-only changes keep the same hash","content changes produce a new hash","issue and pull-request slices parse","null connections normalize to empty and hash identically"] %}Controlled GraphQL payloads prove the distinction between the stored snapshot and its timestamp-free identity.{% /test %}
{% test name="GraphQL transport errors" kind="unit" ref="packages/github/test/polling.test.ts" asserts=["RATE_LIMITED on HTTP 200 becomes a typed rate-limit wait","other GraphQL error messages survive on the typed error's detail"] %}GraphQL reports failures inside a 200 body; both classifications are pinned.{% /test %}
{% test name="Durable trigger lifecycle" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["cold start submits matching state","overlap polls and restart rejoin the original Run","a new loop resets the cursor","new matching content opens new work","unmatching content revokes waiting work"] %}The test uses real local SQLite, the real CEL adapter, and a fake GitHub polling seam.{% /test %}
{% test name="Failure isolation" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["one repository's typed failure is reported on the cycle","the healthy sibling still submits"] %}A failing and a healthy repository share one cycle.{% /test %}
{% test name="Concurrent submissions" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["four items across two repositories open four distinct runs on one SQLite engine"] %}Concurrent repository and item evaluation drive concurrent engine writes.{% /test %}
{% test name="GitHub delay scheduling" kind="unit" ref="packages/orchestrator/test/polling-triggers.test.ts" asserts=["a 120-second GitHub deadline overrides a 60-second factory interval"] %}The Effect test clock checks that no second request starts early.{% /test %}
{% test name="Live repository path" kind="tour" ref="packages/orchestrator/test/integration/polling-triggers.test.ts" asserts=["a temporary label change creates an Event within one interval","the Event payload contains the label","an unchanged state never opens a second run","an orchestrator restart does not create a second identity"] %}This opt-in check uses configured GitHub App credentials. Credential values are omitted here.{% /test %}
{% test name="Cursor persistence" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["an upsert replaces the old JSON value","a new store layer restores the replacement","an undecodable stored value reads as absent"] %}A local SQLite database proves persistence across layer reconstruction.{% /test %}
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

---
walkthrough: 1
title: Operator startup, transcript paging, and structured views
pr: 62
commit: 01b8fee8649326b46006217dfe5254e2b99c8a3b
meta:
  pull-request: "#62"
  pinned-commit: 01b8fee
  scope: usine up and operator surface
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="What changed" icon="git-pull-request" %}
This change completes several operator follow-ups across the local server, the operator API, and the web app.

- `usine up` now accepts a validated port from `--port` or `USINE_PORT`. It also provides help, version output, occupied-port guidance, and setup-page opening.
- The setup screen now states that credentials are read only at startup. The operator must restart `usine up` after credentials are added.
- Transcript reads now have separate full, tail, and backward-page variants. The drawer keeps live tail updates while it prepends older pages.
- The orchestrator returns typed needs, Attempt outcomes, and protocol payloads. The web app now owns operator-facing English.
- Overview projection work is serialized, so concurrent reads for one revision reuse one computation.

The main review points are the cursor boundaries, the merge between backward pages and live tails, and the new API boundary between structured operator data and web copy.
{% /section %}
{% /group %}

{% group label="usine up startup" %}
{% section id="cli-startup" title="Validated commands and startup failures" icon="terminal" related=["setup-mode"] %}
The CLI parser produces a tagged command instead of inspecting raw arguments in the composition root. A port flag takes precedence over `USINE_PORT`; the environment value takes precedence over the default. Both inputs pass through the same branded `Port` schema. Help and version do not load the runtime because `main.ts` imports `up.ts` only for an `UpCommand`.

{% code file="apps/server/src/cli.ts" from=81 to=134 expect="const upPort = (" /%}

The server maps an `EADDRINUSE` bind cause to `PortInUseError`. The entry point catches that error, names the selected port, suggests `--port`, and sets a failing exit code. Other startup failures retain their typed cause.

{% code file="apps/server/src/main.ts" from=6 to=42 expect="const main = Effect.gen(function* () {" /%}
{% /section %}

{% section id="setup-mode" title="Setup-page behavior and restart rule" icon="browser" related=["cli-startup"] %}
The server opens a browser only after the HTTP layer binds and only when credentials are absent. Browser-launch failure is logged and ignored, so it does not stop the setup server. In live mode, the HTTP server still races the orchestrator. A failure in either side stops the process.

{% code file="apps/server/src/up.ts" from=33 to=60 expect="}) {" /%}

{% callout tone="key" %}
The running process does not re-read credentials. The setup banner now tells the operator to stop and rerun `usine up` after credentials are added. This implements the issue's allowed restart-guidance path, not live promotion.
{% /callout %}

{% code file="apps/web/src/main.tsx" from=448 to=458 expect="      {data._tag === \"NeedsSetup\" && (" /%}
{% /section %}
{% /group %}

{% group label="Transcript paging" %}
{% section id="transcript-storage" title="Three explicit read modes" icon="database" related=["transcript-pages"] %}
The engine replaces one query with optional fields by three tagged variants. This prevents a caller from combining a full read, a forward cursor, and a backward cursor in one invalid value.

{% fields %}
{% field name="TranscriptAllQuery" kind="diagnostic" %}Reads the complete transcript for one Attempt.{% /field %}
{% field name="TranscriptTailQuery" kind="live" %}Reads rows whose global sequence is greater than `after`.{% /field %}
{% field name="TranscriptPageQuery" kind="history" %}Reads the newest bounded rows before `before`, or from the current tail when `before` is absent.{% /field %}
{% /fields %}

{% code file="packages/engine/src/model.ts" from=153 to=181 expect="/** Read every row for one Attempt. Intended for execution and diagnostic consumers. */" /%}

For a backward page, SQLite filters with `sequence < before`, scans in descending order with a limit, and then returns rows in ascending append order. The cursor is exclusive, so adjacent pages do not repeat their boundary row.

{% code file="packages/engine/src/store/queries.ts" from=550 to=586 expect="  const transcript = Effect.fn(\"RunStoreQueries.transcript\")(function* (query: TranscriptQuery) {" collapsed=true /%}
{% /section %}

{% section id="transcript-pages" title="Bounded cold reads with live tailing" icon="iterations" related=["transcript-storage","web-presentation"] %}
A cold drawer read runs one bounded page read per Attempt. Each read requests 501 rows. If the extra row exists, the projection removes it and returns 500 visible rows plus a cursor at the first visible sequence. An earlier request validates that the Attempt belongs to the Run before it reads storage.

```pseudo
cold read for each Attempt
  request newest 501 rows
  if 501 rows returned
    omit oldest sentinel
    return 500 rows
    expose cursor at first visible row

earlier read
  verify Attempt belongs to Run
  read rows before cursor

tail read
  read rows after latest visible sequence
```

{% code file="packages/orchestrator/src/operator/projection.ts" from=77 to=138 expect="const readPage = Effect.fn(\"Operator.readTranscriptPage\")(function* (" /%}

The HTTP route accepts exactly three query shapes: no cursor, `after`, or the pair `attempt` plus `before`. Mixed and incomplete shapes fail schema decoding. The web query keeps its one-second live tail for open Runs. A separate mutation fetches an earlier page, merges events by global sequence, and replaces only the cursor for the paged Attempt.

{% code file="apps/web/src/main.tsx" from=204 to=261 expect="  const detail = useQuery<RunDetailView>({" /%}
{% /section %}
{% /group %}

{% group label="Structured operator views" %}
{% section id="web-presentation" title="Libraries return data; the web app writes copy" icon="typography" related=["transcript-pages","overview-cache"] %}
The orchestrator API now exposes tagged need variants, complete Attempt outcomes, and typed channel payloads. It no longer flattens these values into labels, prose, and error strings. Transcript cursors also carry an `attemptId`, which keeps paging scoped to one Attempt.

{% code file="packages/orchestrator/src/operator/model.ts" from=68 to=153 expect="export class ApprovalNeed extends Schema.TaggedClass<ApprovalNeed>(" /%}

The web-only `operator-copy.ts` exhaustively maps those variants to titles and details. It also formats session events, tool activity, failures, interrupts, and brain information. A second consumer of `@usine/orchestrator` can now present the same structured values with different wording.

{% code file="apps/web/src/operator-copy.ts" from=115 to=175 expect="export const presentTranscriptEvent = (event: TranscriptEventView): PresentedTranscriptEvent => ({" /%}
{% /section %}

{% section id="overview-cache" title="One overview projection per cache token" icon="sync" related=["web-presentation"] %}
`Operator.overview` now performs token evaluation, cache lookup, projection, and cache replacement inside `SynchronizedRef.modifyEffect`. Concurrent requests enter this operation serially. After the first request stores a projection, a waiting request with the same token returns it instead of repeating `reader.list()`.

The token includes the durable projection revision, configured repositories and loops, and the latest polling and schedule failures. If the revision singleton is absent, the service cannot detect staleness. It logs the condition, computes without caching, and clears the old cache entry. The first request after revision tracking recovers must therefore rebuild.

{% code file="packages/orchestrator/src/operator/service.ts" from=141 to=194 expect="  const overview = Effect.fn(\"Operator.overview\")((instance: LoadedInstance) =>" /%}
{% /section %}

{% section id="regression-proof" title="Regression coverage" icon="beaker" related=["cli-startup","transcript-pages","overview-cache"] %}
{% tests %}
{% test name="CLI command and bind behavior" kind="unit" ref="apps/server/test/cli.test.ts" asserts=["parses help and version commands","applies flag and environment ports","rejects invalid ports","maps EADDRINUSE to PortInUseError"] %}The test also reads the installed package metadata to verify that version output has a semantic version source.{% /test %}
{% test name="Transcript storage modes" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["full reads return all rows","tail reads are exclusive","cold pages return newest rows","before pages return ascending rows"] %}The SQLite-backed store test exercises the real query seam.{% /test %}
{% test name="Operator paging and cache serialization" kind="unit" ref="packages/orchestrator/test/operator.test.ts" asserts=["cold reads cap each Attempt at 500 rows","earlier cursors reach omitted rows","foreign Attempt cursors fail","concurrent overview reads project once","missing revisions bypass and clear cache"] %}The test runs two overview calls concurrently and counts durable list reads.{% /test %}
{% test name="Drawer merge and cursor replacement" kind="unit" ref="apps/web/test/run-transcript.test.tsx" asserts=["live tails merge without duplicate sequences","child sessions remain distinct","paging replaces only the selected Attempt cursor"] %}The rendering assertions also verify that structured payloads become the expected web copy.{% /test %}
{% test name="HTTP transcript boundary" kind="http" ref="apps/server/test/http.test.ts" asserts=["rejects incomplete cursor combinations","returns 404 for an Attempt outside the Run","preserves setup-mode observation"] %}These checks cover schema decoding and typed error translation at the route boundary.{% /test %}
{% /tests %}

The local-worker test now documents why its 10-second state-poll horizon and 30-second capacity-test timeout are necessary. Its transcript calls and the live integration tests also use the explicit full and tail query variants.
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Server and CLI" only="apps/server/**" /%}
{% filegroup label="Web operator UI" only="apps/web/**" /%}
{% filegroup label="Engine transcript store" only="packages/engine/**" /%}
{% filegroup label="Orchestrator views and tests" only="packages/orchestrator/**" /%}
{% filegroup label="Release metadata" only=".changeset/**" /%}
{% /files %}
{% /section %}
{% /group %}

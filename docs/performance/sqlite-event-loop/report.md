# SQLite event-loop delay

Measurements for [#894](https://github.com/basaltbytes/usine/issues/894), taken on 2026-11-03 on a four-vCPU AMD Ryzen 9 9950X worker running Node 22.23.4. [measurements.json](./measurements.json) contains every sample. These synthetic-store results do not establish latency on the single-vCPU factory host.

## Fixture and procedure

The fixture uses the existing transcript read-plan seeder: 1,000 attempts, 2,000 sessions, and 200,001 transcript rows, including one pool report. Text output has 3,000 bytes of padding. The checkpointed SQLite file contains 801,275,904 bytes (764.2 MiB). Each adapter runs the same deliberately expensive aggregate over transcript JSON:

```sql
SELECT sum(json_extract(envelope, '$.payload.event.totalTokens')) AS total
FROM usine_attempt_transcripts
```

The optimized usage reader from #892 uses the session projection instead. This scan measures isolation from a long read, independently of query optimization. Each adapter warms the query once, then records three runs. A main-thread write to a separate fixture table and an HTTP health request start after a scheduled 20 ms delay during each read. Their reported latency starts before the read, so it includes a delayed timer as well as write and HTTP time.

`monitorEventLoopDelay` samples at 10 ms resolution over each adapter's three-query window, including 30 ms idle periods before and after each query. The production monitor reports and resets every minute; these shorter windows compare the same work across adapters. The comparison uses separate connections for every reader, including the synchronous baseline, so it measures event-loop blocking independently of connection serialization. Queries return one row, excluding the cost of transferring and decoding large result sets.

## Results

| Reader | Median query (ms) | Event-loop p99 (ms) | Event-loop max (ms) | Maximum write + health, including 20 ms timer (ms) |
| --- | ---: | ---: | ---: | ---: |
| Main-thread `node:sqlite`, before | 340.6 | 346.3 | 346.3 | 365.3 |
| Read-only `node:sqlite` worker, after | 313.4 | 10.6 | 11.2 | 23.0 |
| Turso 0.8.3 promise API | 547.7 | 583.0 | 583.0 | 575.9 |
| `sqlite3` 5.1.7 async API | 319.0 | 10.8 | 11.2 | 21.9 |

Use the read-only worker. Both it and the native asynchronous `sqlite3` driver keep the event loop responsive, with similar query time on this fixture. The worker preserves the installed Node SQLite engine and adds no native binding or installation requirement. Turso's promise API still blocks the event loop for this query and requires the experimental `generated_columns` option to open this schema.

WAL snapshots let the worker read while the original main connection writes. Transactions and reserved connections retain the original driver, so uncommitted reads, savepoints, rollback, and commit callbacks keep their behavior. Connection-local state requires those connections explicitly. Large row cloning, application decoding, explicit transactions, and other main-connection statements can still delay the event loop. A queued read can wait behind another read on the single worker.

## Regression coverage

`sqlite-concurrency.test.ts` runs a recursive read for at least one second while three transcript appends and HTTP health requests each finish within 100 ms, including timer delay. It checks persisted append count and proves that the read remains in progress after each append. The original adapter fails the latency assertion. The suite also covers CTE reads and writes, comments and quoted text, object and value-array results, safe integers, binary bindings, reserved temporary tables, uncommitted reads, savepoint and transaction rollback, commit callbacks, and continued reads after SQL and binding failures. The existing statement-retention suite still verifies collection of completed responses and preserved SQL span relationships. Provider-capacity scenarios verify coherent run and attempt state during completion; queued CI fix scenarios wait for admission explicitly before closing the engine admission gate.

## Reproduction

Install comparison drivers outside the workspace, then run the benchmark from the repository root:

```sh
npm install --prefix /tmp/usine-sqlite-evaluation \
  @tursodatabase/database@0.8.3 sqlite3@5.1.7
pnpm --filter @usine/engine exec node --experimental-strip-types \
  test/store/read-plans/benchmark.mts /tmp/usine-event-loop-fixture \
  /tmp/usine-sqlite-evaluation/node_modules/@tursodatabase/database/dist/promise.js \
  /tmp/usine-sqlite-evaluation/node_modules/sqlite3/lib/sqlite3.js
```

The first run creates and seeds the fixture. Later runs reuse it. Omit the last two arguments to compare only the existing driver and the read worker. Allow at least 1 GiB of free disk space. The benchmark appends to its own fixture table without changing transcript rows.

Run the regression suite:

```sh
pnpm --filter @usine/engine exec vitest run \
  test/store/sqlite-concurrency.test.ts test/store/statement-retention.test.ts
```

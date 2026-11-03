# Runtime store read indexes

Measurements for issue [#890](https://github.com/basaltbytes/usine/issues/890), taken on 2026-11-03. The baseline is commit `92f21cee0373ea64dc5d98c81b4f017941bde399`. [queries.json](./queries.json) contains the captured SQL, bound parameters, complete `EXPLAIN QUERY PLAN` output, result counts, SQL timings, and full reader timings for both versions. Query order within each reader matches the numbered rows below.

## Scope

This change indexes runs and attempts. Transcript storage and usage computation remain unchanged. Transcript queries appear in the measurements to record their costs, but the plan assertions exclude them.

## Fixture and method

The persistent fixture contains 1,000 runs, 1,000 attempts, 100 items, and 200,000 transcript rows. It has 988 succeeded runs, one CI handoff, one CI wait, and 10 running runs. Each attempt has two sessions and 200 transcript entries, including 10 token reports; text output has a 3,000-byte body. This is a synthetic fixture, not a copy of production data.

The baseline database is 789,692,416 bytes (753.1 MiB). Measurements run on a four-vCPU AMD EPYC-Rome worker, Node 22.23.4, and SQLite 3.53.4. The capture test invokes the real `RunReader`, `RunStore`, and store query methods with Drizzle's `EffectLogger`. Timings below are the median of five executions of each captured SQL statement with its parameters. They include fetching the result rows, and exclude Effect Schema decoding and HTTP serialization. Full reader timings in the JSON file are single samples and are not endpoint latency measurements. The board read selects all 100 fixture items.

The baseline uses the same fixture and capture harness with the production files and migrations from the baseline commit. Its plan assertion fails, as expected. No `ANALYZE`, index hints, or planner settings change between measurements.

## Migration

Startup on a fresh copy of the 789.7 MB baseline store takes 47.595 ms, including opening the connection and applying the migration. The database is 789872640 bytes after checkpointing, an increase of 180224 bytes. The migration contains only five `CREATE INDEX` statements; it rewrites no tables and reads no transcript envelopes. All row counts and the SHA-256 of the ordered transcript envelopes match before and after.

## Indexes and query shapes

| Index | Read path |
| --- | --- |
| `usine_runs_state_opened` on state tag, open time, run ID | Open-run lists, CI waits, and run reconciliation search by state. Sorting several open states still uses a temporary B-tree over the open matches. |
| `usine_runs_closed_opened` on closure presence, open time, run ID | Recent history searches the closure expression and reads the requested order directly. The predicate explicitly compares SQLite's closure expression with `1` to match this expression index. |
| `usine_runs_closed` on close time, run ID | Closed history and statistics search the close-time range in order. |
| `usine_runs_fix_run` on the text CI fix run ID | Board selection searches older handoffs linked to a selected fix run. The `CAST` gives the JSON expression the same text affinity as the run ID subquery. |
| `usine_attempts_run_number` on run ID, attempt number | Attempt detail, summaries, and the board's latest-attempt lookup avoid sorting behind the existing step-name key. |

The existing unique `usine_runs(event_id)` index already supports event joins, item histories, and polling submissions; another event-ID index would duplicate it. Board selection combines current run IDs and linked handoff IDs with `UNION ALL` inside `IN`, so duplicate IDs do not duplicate results. Both branches use indexed searches, and the window selection executes twice instead of the four executions in the indexed `OR` plan. Existing item and loop/item indexes support the trigger-event side. Board windows still sort the selected item histories; a run-only index cannot order by the item key stored in the trigger-event table.

The normal test rejects a `SCAN` of any non-transcript `usine_*` base table in the captured hot queries. It permits scans of derived window results, `json_each`, and JSON fact arrays. It also verifies that an older handoff remains visible when its CI fix is current. Transcript reads run only when a benchmark report is requested and are excluded from the plan guard.

## SQL timings

Every captured statement has a plan in [queries.json](./queries.json), including reads that already used indexes. Times are milliseconds. A reader with several statement shapes has one row per shape; repeated attempt batches with the same SQL use the last batch's parameters.

| Reader and statement | Before | After |
| --- | ---: | ---: |
| overview/desk open runs (1) | 0.622 | 0.145 |
| overview/desk open runs (2) | 0.134 | 0.170 |
| overview/desk open runs (3) | 0.082 | 0.108 |
| overview recent history (1) | 0.698 | 0.141 |
| overview recent history (2) | 4.894 | 0.437 |
| overview recent history (3) | 0.307 | 0.312 |
| desk recently closed (1) | 4.017 | 0.283 |
| desk recently closed (2) | 0.173 | 0.154 |
| desk project closed (1) | 5.331 | 0.314 |
| desk project closed (2) | 0.186 | 0.106 |
| statistics window (1) | 3.779 | 1.896 |
| statistics window (2) | 0.646 | 0.331 |
| statistics window (3) | 0.648 | 0.331 |
| statistics all history (1) | 6.607 | 11.961 |
| statistics all history (2) | 0.466 | 0.644 |
| statistics all history (3) | 0.478 | 0.605 |
| board history/current runs (1) | 3.020 | 3.816 |
| board history/current runs (2) | 6.925 | 5.400 |
| board history/current runs (3) | 4.491 | 3.335 |
| board history/current runs (4) | 1.615 | 1.328 |
| board history/current runs (5) | 11.833 | 9.011 |
| board history/current runs (6) | 0.502 | 0.321 |
| board history/current runs (7) | 0.034 | 0.025 |
| task history (1) | 0.095 | 0.112 |
| task history (2) | 0.094 | 0.068 |
| run detail (1) | 0.035 | 0.036 |
| run detail (2) | 0.034 | 0.028 |
| run detail (3) | 0.037 | 0.029 |
| run summary (1) | 0.124 | 0.126 |
| run summary (2) | 0.042 | 0.026 |
| run events | 0.026 | 0.024 |
| run transcript page | 0.170 | 0.156 |
| run session state | 0.942 | 0.886 |
| run worker state | 0.797 | 0.713 |
| usage per attempt | 0.809 | 0.761 |
| usage across all runs | 0.978 | 0.774 |
| usage pool limits | 0.064 | 0.059 |
| CI wait reconciliation (1) | 0.188 | 0.019 |
| CI wait reconciliation (2) | 0.042 | 0.040 |
| CI wait reconciliation (3) | 0.047 | 0.043 |
| CI wait reconciliation (4) | 0.037 | 0.047 |
| polling admitted event | 0.030 | 0.028 |
| polling blocking run | 0.104 | 0.144 |
| polling next queued (1) | 0.034 | 0.032 |
| polling next queued (2) | 0.019 | 0.022 |
| polling next queued (3) | 0.049 | 0.040 |
| reconciliation runs to drive | 0.323 | 0.047 |

The all-history statistics query returns every closed run and is slower in this sample. Its indexed traversal preserves the required range search and order, but it cannot bound the result count. These results do not establish a speedup for every reader.

## Known transcript costs

Usage still selects each session's highest cumulative token report by scanning the attempt's transcript candidates and extracting JSON. Session state also groups JSON fields and uses a temporary B-tree. Worker state examines transcript candidates, and pool limits scan the existing small partial index. The fixture's per-attempt usage query examines 200 rows. Reading usage across all 1,000 attempts takes 1718.2 ms before and 2102.3 ms after in single reader samples. These paths remain a separate design study; this PR adds no transcript indexes, generated columns, tables, or write hooks.

## Reproduction

Run the plan regression with its temporary fixture:

```sh
pnpm --filter @usine/engine exec vitest run test/store/read-plans/read-plans.test.ts
```

For the large persistent fixture, use a new directory and set both variables:

```sh
USINE_STORE_BENCHMARK_DIRECTORY=/path/to/empty/benchmark \
USINE_STORE_BENCHMARK_REPORT=/tmp/runtime-read-queries.json \
pnpm --filter @usine/engine exec vitest run test/store/read-plans/read-plans.test.ts
```

The first run creates the fixture; later runs reuse it. To measure migration startup, copy a baseline fixture's `.usine/runtime.sqlite` into a new benchmark directory before running the command against this branch. Creating a fixture on the indexed schema measures empty-store startup instead.

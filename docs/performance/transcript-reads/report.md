# Transcript read models

Measurements for [#892](https://github.com/basaltbytes/usine/issues/892), taken on 2026-11-03 against baseline commit `2482038ecb`. [queries.json](./queries.json) contains captured SQL, parameters, query plans, timings, and integrity checks.

## Fixture and migration

The baseline has 1,000 attempts, 2,000 sessions, and 200,000 transcript rows in a 789,884,928-byte SQLite file (753.3 MiB). Each attempt has 200 entries, including 10 token reports, with 3,000-byte text output. This is a synthetic store, not production data. The migration runs on a separate copy of that populated store, on a four-vCPU AMD EPYC-Rome worker running Node 22.23.4 and SQLite 3.53.4.

Startup, including opening the connection and applying the migration, takes **2,182.6 ms**. After checkpointing, the file is **800,595,968 bytes**, an increase of **10,711,040 bytes** (10.2 MiB). Creating the virtual columns changes only the schema. The migration creates the kind index, backfills the session and pool tables, and drops the old pool index after its backfill. It rebuilds no existing table and creates no `WITHOUT ROWID` table. The populated migration test also verifies pool backfill across attempts; the large baseline fixture has no pool reports.

All 200,000 transcript rows retain the same SHA-256 over their original columns in sequence order: `dc92def7ec4185952b48ef599248d4c9bf175e5a07467d19b938681806d38c27`. Every session usage row matches the original highest-token grouping, including the selected envelope, timestamp, and sequence. These synthetic-store timings do not establish production upgrade time.

## Reads

| Reader | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Usage, one attempt | 2.129 | 0.684 |
| Usage, all 1,000 attempts | 1,973.228 | 366.738 |
| Session state | 6.881 | 1.290 |
| Worker notice | 3.196 | 3.029 |

These are single complete reader samples, including Effect and schema decoding. The JSON also records the median of five executions of each captured SQL statement. The all-attempt sample still makes one read per attempt; it does not use a batch API. The fixture has no worker notices, so its worker timing measures an empty result.

Usage searches the session table's composite primary-key index. Pool reads scan only the small pool table. Session state uses two searches of the kind index: one constrained by attempt, payload, and event tags; the other by attempt and intervention payload tags. The worker query selects the maximum sequence through the kind index, then fetches that row by primary key. These plans pass both with and without `ANALYZE`. Grouping and ordering the matched session rows can use temporary B-trees.

## Regression coverage

The plan test captures the real reader queries on every run and rejects transcript scans. Usage and pool tests cover duplicate delivery and global append order; usage also covers shared session IDs across attempts, lower cumulative reports, and transaction rollback if projection persistence fails. Migration parity compares both tables with the previous transcript grouping, including equal token totals with different costs, and checks unchanged transcripts and enabled foreign keys. Existing session-state tests cover launch metadata, interventions, and later activity.

## Reproduction

Run the plan regression:

```sh
pnpm --filter @usine/engine exec vitest run test/store/read-plans/read-plans.test.ts
```

On the baseline commit, create the large fixture in an empty directory:

```sh
USINE_STORE_BENCHMARK_DIRECTORY=/path/to/baseline \
USINE_STORE_BENCHMARK_REPORT=/tmp/transcript-before.json \
pnpm --filter @usine/engine exec vitest run test/store/read-plans/read-plans.test.ts
```

Copy its checkpointed `.usine/runtime.sqlite` to another directory with the same layout. On this branch, run the command with the copy's directory and a new report path. `migrationMillis` measures startup on the copy; `migrationBytes` records file size after migration and checkpointing, before the reader measurements and `ANALYZE`. Reusing an already migrated store measures connection startup instead of migration.

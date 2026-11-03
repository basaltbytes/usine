# Litestream replication for upgrade rollback

Research date: 2026-11-03. Issue: [#897](https://github.com/basaltbytes/usine/issues/897).
Repository baseline: `2482038ecbe239be05898ef6ce40efc0fbf7bbc8`.
Memory follow-up: the same dependency lockfile and large-fixture workload.

## Recommendation

**Keep full-copy backups for managed upgrades.** A 751.88 MiB runtime database and
150.36 MiB durable database restored in 23.05–39.26 seconds across the local trials.
Litestream can replicate both usine SQLite files, and a recorded replica
transaction ID can recover a database from
before a migration. Replacing the helper's backups also requires a write barrier
across both stores, durable rollback metadata, retention of the exact recovery
points, and a restore budget that includes storage failures. The local measurements
below establish feasibility; they do not establish a recovery deadline from object
storage on the factory host.

This report changes no production behavior. The backup and restore contract in
[ADR 0010](../../adr/0010-single-sqlite-runtime-store.md) continues to apply.

## Method and limits

The experiment uses **Litestream 0.5.17**, released on 2026-08-31, under the
**Apache License 2.0**. The Linux x86-64 release archive has SHA-256
`cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d`, matching the
release's `checksums.txt`. Sources: [release][release], [license][license].

[measure.mjs](./measure.mjs) contains the executable experiment;
[results.json](./results.json) contains the original full-run results;
[memory-results.json](./memory-results.json) contains a separate large-fixture
memory run. The checked-in JSON replaces
the absolute measurement directory with `<measurement-directory>`; numeric values
are unchanged. All replicas use local files on the worker's persistent
filesystem. The experiment uses generated data, rather
than a copy of the factory's databases. The reported factory sizes in #897 supply
the size targets, not a captured production write trace.

The worker runs Linux 6.8 on x86-64, Node 22.23.4, and the dependency versions in
`pnpm-lock.yaml`. The experiment and its children share CPU affinity to **one core**
through `taskset -c 0`. The worker has 7.75 GiB of RAM and a cgroup memory limit of
about 6.75 GiB, with no swap. The attempt container cannot create cgroups or user
namespaces, so the experiment measures process memory without enforcing a 2 GiB
limit. Litestream runs with `GOMAXPROCS=1` and `GOMEMLIMIT=256MiB`; the latter is a
soft Go memory target, **not an RSS limit**. The factory budget for comparison is
**1 vCPU, 1.9 GB RAM, no swap**, with the usine server using about **300–500 MB**.

The WAL probe uses Node's SQLite connection with settings read from the installed
Effect and pi-durable adapters. Each commit appends a 2 KiB payload and updates a
run counter in one transaction. It requests up to 20 commits/s for 60 seconds,
then batches of 100 commits with a 200 ms pause for 10 seconds while a second
connection holds a read transaction, then releases that reader and writes for
another 5 seconds. An in-flight batch can overrun its target duration. Disk
latency can reduce the achieved rate; the results record actual commits and
elapsed time. This models append traffic, state updates, and a
slow reader, without reproducing usine's SQL indexes, triggers, or full workload.
It reuses the same payload, so its replication CPU and byte counts describe a
compressible write case. Each WAL case runs once in sequence; latency differences
between cases are not a controlled performance comparison.

The original full run samples WAL size and Litestream RSS with a 100 ms timer.
Synchronous SQLite batches can delay that timer, so sampled peaks can miss brief
spikes. CPU seconds come from Linux `/proc/<pid>/stat` with `CLK_TCK=100`. Its
restore measurements use Python `resource.getrusage(RUSAGE_CHILDREN)` and a
monotonic wall clock. The memory run samples replicator RSS with `ps -o rss=` at
100 ms intervals, from control-socket readiness through the final restore. Each
restore runs under GNU `time -v`, recording **Maximum resident set size (kbytes)**,
user and system CPU time, and a monotonic wall clock. On Linux these memory values
use KiB; the tables convert them to MiB. Both runs include process startup and the
requested quick integrity check. The filesystem
cache is warm, with replicas and destinations on the same disk. Network latency,
S3 throttling, retries, cold disk reads, package installation, and server startup
are outside those restore timings.

## Checkpoints and WAL growth

The adapter probes return these connection settings:

| Setting | Effect SQLite 4.0.6 | pi-durable 1.4.0 / chord 1.4.0 |
| --- | --- | --- |
| `journal_mode` | `wal` | `wal` |
| `wal_autocheckpoint` | 1000 pages | 1000 pages |
| `busy_timeout` | 5000 ms | 5000 ms |
| `synchronous` | 2 (`FULL`) | 1 (`NORMAL`) |
| `page_size` | 4096 bytes | 4096 bytes |

usine's [local adapter](../../../packages/engine/src/database/local-sqlite.ts)
opens the Effect SQLite client without overriding checkpoints. The installed
`@effect/sql-sqlite-node` source configures WAL and the busy timeout, leaving
SQLite's automatic checkpoint setting at its default. pi-durable delegates to
chord's Node adapter, which explicitly configures the values above. Its
`walAutoCheckpointPages` option can set automatic checkpoints to zero.
Sources: [Effect adapter][effect], [pi-durable adapter][pi], [chord adapter][chord].

| Connection / replication | Steady / burst commits per second | Commit p50 / p99 (ms) | Peak WAL (MiB) | Peak sampled RSS (MiB) | Replicator CPU (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `FULL`, no replica | 5.16 / 7.12 | 72.58 / 874.95 | 3.93 | — | — |
| `FULL`, auto 1000 | 3.25 / 3.08 | 152.39 / 1558.72 | 3.11 | 35.57 | 2.00 |
| `FULL`, auto 0 | 4.98 / 14.84 | 73.08 / 834.01 | 4.07 | 34.11 | 0.72 |
| `NORMAL`, auto 1000 | 19.28 / 400.36 | 0.03 / 1.76 | 67.33 | 34.89 | 0.77 |
| `NORMAL`, auto 0 | 19.31 / 307.44 | 0.02 / 2.83 | 52.59 | 36.09 | 0.85 |

For every replicated case, the probe flushes the replica, restores its recorded
TXID, checks the full SQLite integrity, and compares both the transcript row count
and run counter with the number of committed writes. Those assertions must pass
for the script to complete.

Litestream disables automatic checkpoints on **its own connection** and holds a
read transaction to prevent other connections from checkpointing unreplicated WAL
frames. Automatic checkpoint settings belong to each connection; changing the
replicator's setting does not change usine's writers. In 0.5.17, Litestream uses
passive checkpoints at 1000 pages or a 1-minute interval and an emergency truncate
threshold of 121359 pages, about 500 MB with 4 KiB pages. These are triggers, not a
hard WAL size ceiling. A retained reader, slow storage, or sync failures can delay
progress. Sources: [checkpoint implementation][checkpoints], [operating tips][tips].

**The existing settings can coexist at the measured rates.** The upstream guidance
still recommends disabling automatic checkpoints on application connections for
high write loads: a checkpoint race can make Litestream miss a WAL update and
recover by taking another full snapshot. A deployment that adopts replication
should set `PRAGMA wal_autocheckpoint=0` on the runtime connection before migrations
and pass `{ walAutoCheckpointPages: 0 }` when opening pi-durable storage. Retain the
5-second busy timeouts. Configuration and auth share the runtime connection, so
they need no additional writer connection changes. [Upstream guidance][tips]

Chord also requests `wal_checkpoint(TRUNCATE)` when closing its database.
Disabling automatic checkpoints does not disable that explicit checkpoint. The
write probes use raw Node connections with matching settings, so adopting
replication also requires testing pi-durable shutdown with the replicator active
and checking its busy-timeout behavior. [Chord adapter][chord]

The retained-reader phase measures temporary WAL growth. SQLite can reuse a WAL
without shrinking its physical file, so a large final `-wal` size alone does not
prove a checkpoint stall. The factory's actual rates and sustained readers still
need observation before choosing thresholds. In an adoption, monitor WAL bytes,
checkpoint busy results, replica lag, sync errors, free disk, and snapshot count;
refuse an upgrade when its recovery point cannot be confirmed.

## Upgrade rollback

### Restore measurements

The original full run uses a runtime database in the 750 MiB size class and a
durable database in the 150 MiB size class. Each starts with random 3900-byte blobs;
deleting every fourth row leaves free pages without vacuuming. SQLite's backup
API copies each fixture before replication starts.

| Fixture | File / backup size (MiB) | Free pages / total pages | SQLite backup time (s) |
| --- | ---: | ---: | ---: |
| Runtime | 751.88 / 751.88 | 47999 / 192481 | 35.45 |
| Durable | 150.36 / 150.36 | 9599 / 38493 | 8.61 |

Initial replication of the pair took **92.59 s**, consumed
**74.65 CPU seconds**, and reached **79.91 MiB** sampled
replicator RSS. The file replica directories held
**2110.36 MiB** at that boundary, including LTX levels
and snapshots. Compaction timing affects that total; it is not a steady-state
storage forecast. Local tracking directories and rollback staging require
additional space.

| Trial | Runtime (s) | Durable (s) | Pair (s) | Extra full integrity checks (s) | Peak restore RSS (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 26.04 | 4.09 | 30.13 | 1.83 | 74.02 |
| 2 | 21.26 | 3.95 | 25.21 | 1.66 | 96.23 |
| 3 | 20.18 | 3.94 | 24.13 | 0.17 | 91.47 |

The pair column sums the two sequential restore commands, including their quick
checks; full integrity checks add the separate time shown. These timings exclude
publishing staged files and restarting usine. Both confirmed boundary TXIDs were
`0000000000000002`. The runtime timestamp restore took
**18.46 s**, with a marker read and without the CLI quick check.

Both databases receive a `before` marker before replication. After their replica
positions are confirmed, the experiment writes `after` and adds a column, modeling
startup migrations. Each of the three restore pairs must recover `before`, omit
the added column, and pass full SQLite integrity checks. A separate timestamp
restore must also recover `before`. These checks establish data and schema
rollback at a known quiet boundary, rather than successful command exit alone.

The helper's **180 seconds applies to each health check**, beginning after the
restore and service start. It is not an existing limit on the whole rollback:
[`restore_data`](../../../apps/server/src/upgrade/helper.sh) runs before
`healthy`. A replacement needs its own bounded restore deadline and must reserve
time for package recovery and startup. The measured local pair fits within 180
seconds; that result cannot guarantee a remote restore within the same interval.

### Factory memory budget

The separate memory run uses the same **751.88 MiB runtime** and **150.36 MiB
durable** fixture sizes, including the same free-page counts. It repeats initial
replication, migration-marker rollback, three sequential restore pairs, and the
timestamp restore on one CPU core. The replicator remains active during these
restores so its samples include overlapping snapshot and compaction work.
[memory-results.json](./memory-results.json) records the measurements and methods.

Initial replication takes **46.79 s** and **15.74 CPU seconds**, with **79.84 MiB**
sampled peak replicator RSS. Across initial replication and all restores, the
replicator reaches **84.09 MiB** sampled peak RSS and uses **25.13 CPU seconds**;
the probe collects **1564 samples**. The replica directories total **1492.62 MiB**
after initial replication. This total varies with compaction timing.

| Trial | Runtime restore (s) | Durable restore (s) | Pair (s) | Runtime peak RSS (MiB) | Durable peak RSS (MiB) | Extra full integrity checks (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 35.46 | 3.80 | 39.26 | 88.32 | 49.35 | 0.23 |
| 2 | 19.90 | 3.80 | 23.70 | 90.94 | 49.98 | 0.23 |
| 3 | 19.10 | 3.95 | 23.05 | 78.30 | 49.22 | 0.27 |

All restored pairs recover the pre-migration marker and schema and pass full
integrity checks. The confirmed runtime TXID is `0000000000000002`; the durable
TXID is `0000000000000001`. The timestamp restore also recovers the pre-migration
marker, taking **22.48 s** with **84.27 MiB** peak RSS.

For the factory's **1.9 GB RAM, no-swap** budget, allow **300–500 MB** for the usine
server. These budget values use decimal GB and MB. Adding the upper **500 MB**
server allowance to the separately observed **84.09 MiB** replicator peak and
**90.94 MiB** largest restore peak totals about **684 MB**, leaving about
**1.22 GB** for the operating system, filesystem cache, Pi parents, and other
services. The restore commands run sequentially, so this calculation uses the
largest single restore peak. It sums separate peaks as a planning allowance;
it does not measure simultaneous total host use.

The observed process memory fits this allowance, but **RSS does not include the
host's filesystem cache or memory used by other processes**. The worker's cgroup
memory limit remains about 6.75 GiB. Its warm cache can improve restore
times compared with the factory, and no 2 GiB memory limit is enforced. Sampling
can miss short replicator spikes, including work before socket readiness and at
shutdown; GNU `time -v` records each restore's process high-water RSS. The sampling
commands also consume CPU on the shared core. These results support a process
memory budget, not a guarantee against memory pressure, an out-of-memory kill, or
a factory restore deadline. The two runs are separate observations, not a
controlled timing comparison.

### Record TXIDs, not just a wall-clock timestamp

Litestream 0.5 uses LTX files and supports `restore -txid <hex>` and
`restore -timestamp <RFC3339>`. The 0.3 generation identifier is not the recovery
interface for this version. Litestream TXIDs describe replication batches, not
individual usine transactions. Timestamp selection uses LTX file timestamps;
it cannot identify an arbitrary SQLite commit between two replication batches.
A timestamp saved before the last pre-upgrade writes are replicated can therefore
select an older state. Sources: [restore command][restore], [restore planner][planner].

The measured boundary uses the control socket:

```sh
litestream sync -socket /run/usine/litestream.sock -wait -timeout 120 -json /path/to/runtime.sqlite
```

The JSON response supplies decimal `txid` and `replica_txid`. Check that the replica
has reached the requested position, then encode the recorded TXID as 16-digit
hexadecimal when passing it to `restore -txid`. `-wait` synchronizes the database WAL and then
its replica. It only defines a common application boundary when application
writers are stopped. Sources: [sync command][sync], [sync implementation][sync-implementation].

A replacement helper would need this sequence:

1. Check disk and replica availability, then stop the orchestrator and verify that
   both application writers have closed. Keep configuration CLI writes behind the
   same barrier until the manifest is recorded. This moves the current online
   backup's failure-before-shutdown guarantee: a failed replica flush can now cause downtime.
2. Flush **both** files with `sync -wait`, verify the confirmed positions, and write
   an owner-only manifest outside the databases before installing the target.
   Record instance identity, previous and target usine versions, Litestream
   version, database paths and presence, replica locations and lineage, per-file
   TXIDs, and boundary time. Record configuration revision for diagnostics.
3. Preserve the complete restore chain for each TXID through installation,
   readiness checks, rollback, and the operator's recovery retention period.
   Installation can already take longer than the default five-minute L0 retention.
4. On failure, stop the server **and replicator**, restore both files into staging,
   verify integrity, remove stale SQLite WAL/SHM files, and publish the pair before
   restarting the previous version. Preserve an absent durable database as absent.
   A failed restore keeps the server stopped and leaves the recovery metadata.
5. Reconcile Litestream's local tracking directory and replica lineage before
   resuming replication from restored files; keep the old recovery chain available.
   Run one replicator per replica path, as upstream requires.

Retention is part of correctness. Defaults keep snapshots for 24 hours and raw L0
files for five minutes after compaction. An old exact TXID can become unreachable
when only a compacted file spanning that TXID remains: the restore planner skips
files whose maximum TXID is after the target. A manifest alone does not pin those
files. Adoption needs a tested retention or archival policy for the whole chain,
including a restore after compaction and expiry; the short restore experiment
here does not test that policy. Sources: [defaults][defaults], [L0 retention][l0],
[restore selection][planner], [one writer per path][tips].

## The second file, configuration, and auth

There are **two database files** to replicate:

| File | Contents and boundary |
| --- | --- |
| `.usine/runtime.sqlite` | Runtime state, configuration entities and revisions, member records, and instance tokens. These stores use the shared SQLite connection. |
| `.usine/durable.sqlite` | Pi parent tasks and conversations, written through pi-durable's separate connection. |

The [server composition](../../../apps/server/src/up.ts),
[configuration layer](../../../apps/server/src/configuration/runtime.ts), and
[auth store](../../../apps/server/src/auth/sqlite.ts) establish the runtime sharing;
[durable storage](../../../packages/durable/src/live.ts) opens the second file.
[ADR 0031](../../adr/0031-authored-configuration-in-the-database.md) describes
configuration persistence.

Litestream replicates files independently and adds no cross-file transaction.
Using the same timestamp for both cannot create one. The existing
[`usine backup`](../../../apps/server/src/backup.ts) copies durable storage before
the runtime store and relies on startup reconciliation for the separate snapshots
([ADR 0010](../../adr/0010-single-sqlite-runtime-store.md)). A stopped-writer boundary
plus two confirmed TXIDs gives a common quiet point for upgrade rollback, while
continuous disaster recovery still needs reconciliation. The generated markers
verify a quiet pair; they do not test reattachment of live Pi tasks.

SQLite replication also leaves `.env`, GitHub App credentials, instance identity,
attempt connection records, known-host records, worker state, and referenced SSH
keys outside its coverage. Follow the
[instance backup guide](../../../apps/docs/src/content/docs/guides/back-up-instance-state.md)
for those files. Object storage for the runtime replica must protect auth and
configuration data as well as run history.

## Operations and adoption conditions

Run the Go executable as a **separate systemd service**, with one configuration
covering both databases and a private control socket. This keeps it available
while the upgrade helper replaces the server package. Litestream's `-exec` mode
can wrap a child process, but it couples shutdown to that child; embedding the Go
library in the Node server would add an integration boundary without helping the
independent helper. Sources: [replicate command][replicate], [sample configuration][defaults].

The factory memory comparison above budgets for the usine server as well as
Litestream. Reserve the remaining memory for the operating system, filesystem
cache, Pi parents, and other services. Initial snapshots and compaction also
compete with usine for the single CPU; their peak work differs from idle
replication. Measure sustained writes and restore/startup overlap on the factory
before adopting replication.

Litestream still creates full snapshots and local tracking files. Replacing
per-upgrade copies would reduce repeated snapshot creation at each upgrade, but
would not eliminate full-database transfers or the local staging space required
for rollback. The fixture's backup sizes also confirm that the SQLite backup API
retains free pages; replication does not compact the live database.

For remote storage, use a dedicated bucket or prefix per instance, database, and
replica lineage, with permissions to list, read, write, and delete the objects
needed by replication and retention. Litestream supports S3-compatible endpoints
and explicitly recognizes Hetzner Object Storage. Configure the endpoint, region,
bucket, prefix, credentials, TLS, and provider-appropriate path-style addressing;
keep credentials in the service environment with owner-only access. Align object
lifecycle expiry with Litestream retention so it cannot delete a pinned rollback
chain. Sources: [S3 configuration and provider detection][s3], [retention][defaults].

This spike uses the permitted file backend. It measures neither MinIO nor Hetzner
latency, provider behavior, request cost, encryption, nor outage recovery. Remote
restore time must be measured before changing the helper's guarantee. For scale,
transferring 900 MiB alone takes at least 75.5 seconds at 100 Mbit/s and 377.5 seconds
at 20 Mbit/s, before protocol overhead, decompression, integrity checks, or startup.
Those are transfer calculations, not benchmark results.

## Reproduce

Use the repository baseline above and its lockfile. Install workspace dependencies,
download the pinned release from [the release page][release], verify its checksum
above, and extract it. On Linux, with GNU `time` and `timeout` on `PATH`, `ps`,
`taskset`, a cgroup v2 memory controller, and a free persistent disk directory:

```sh
pnpm install --frozen-lockfile
taskset -c 0 node docs/research/litestream/measure.mjs \
  "$PWD" /absolute/path/to/new-measurement-directory /absolute/path/to/litestream
```

Add `--large-only` after the Litestream path to repeat only the large-fixture
replication and restore measurements, as in `memory-results.json`. Keep the new
results separate from the original full run.

Use a directory that does not exist; the script creates it and leaves databases,
replicas, logs, timing files, and WAL/RSS samples there for inspection. Reserve at
least 12 GiB of free disk, and keep the directory outside `/tmp` when `/tmp` is a
small tmpfs. Only the short-lived control sockets use the temporary directory.
The run takes several minutes. It fails if replicated counts, rollback markers,
schema checks, or integrity checks disagree.

[release]: https://github.com/benbjohnson/litestream/releases/tag/v0.5.17
[license]: https://github.com/benbjohnson/litestream/blob/v0.5.17/LICENSE
[checkpoints]: https://github.com/benbjohnson/litestream/blob/v0.5.17/db.go
[tips]: https://litestream.io/tips/
[effect]: https://www.npmjs.com/package/@effect/sql-sqlite-node/v/4.0.6
[pi]: https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.4.0
[chord]: https://www.npmjs.com/package/@earendil-works/chord/v/1.4.0
[restore]: https://github.com/benbjohnson/litestream/blob/v0.5.17/cmd/litestream/restore.go
[planner]: https://github.com/benbjohnson/litestream/blob/v0.5.17/replica.go
[sync]: https://github.com/benbjohnson/litestream/blob/v0.5.17/cmd/litestream/sync.go
[sync-implementation]: https://github.com/benbjohnson/litestream/blob/v0.5.17/store.go
[defaults]: https://github.com/benbjohnson/litestream/blob/v0.5.17/etc/litestream.yml
[l0]: https://github.com/benbjohnson/litestream/blob/v0.5.17/db.go#L3017
[replicate]: https://github.com/benbjohnson/litestream/blob/v0.5.17/cmd/litestream/replicate.go
[s3]: https://github.com/benbjohnson/litestream/blob/v0.5.17/cmd/litestream/main.go#L1527

# Sources for boxd attempt machines

Research for [issue #1103](https://github.com/basaltbytes/usine/issues/1103): where should a boxd
attempt machine come from? The driver restores each one from a snapshot
(`CreateVmFromSnapshot`). boxd also forks live or hibernated machines (`ForkVm`), creates machines
from a machine spec, sets team default snapshots, attaches persistent disks, and restores
checkpoints in place. Snapshot date: 2026-11-11.

The goal is a machine that is ready to run an attempt as fast, as cheaply, and as reproducibly as
boxd allows: the attempt image present, pnpm and Turbo caches warm, a clean tailnet join with the
machine's own ephemeral key, the egress allowlist in force before anything runs, isolation kept,
and no state from another attempt. Each mechanism below is judged against that goal.

## Method

All numbers marked **measured** come from probes run on 2026-11-11 against boxd's hosted `fra`
region. Numbers marked **quoted** come from the SDK documentation or earlier notes, with the source
named.

- Client: a macOS workstation with Node.js 24.22.2 and `@boxd-sh/sdk` 0.3.0. Every machine call,
  including each `Exec`, uses the API key as the bearer, as the driver does since
  [#1128](https://github.com/basaltbytes/usine/pull/1128).
- Source: the factory's `usine-attempt` snapshot, version 1 (2 vCPU, 8 GiB, 16.2 GB, Ubuntu
  24.04.5, kernel 6.18), used read-only.
- Machines: 29 machines named `probe-1103-*`, all isolated, at most three alive at once, each
  created with a 30- or 90-minute delete timer as a backstop. Two probe snapshots and one probe disk
  were created. Every probe resource was deleted afterwards (see [Cleanup](#cleanup)).
- Template: `probe-1103-tpl`, restored from `usine-attempt`, then warmed with a mirror of this
  repository, a pnpm store, and a Turbo cache. It ran three loops started with `setsid`: a
  timestamp every 50 ms, which shows when the machine was paused; a request to `example.com` by
  name; and every 100 ms a request to `example.com` at a fixed address, which shows when egress
  that the allowlist forbids got through. The third loop also logged an uncached DNS query through
  `resolvectl`, which failed on every line and is left out of the results.
- Allowlist under test: `*.tailscale.com` and `registry.npmjs.org`. `example.com` is outside it.

The probe scripts are in [`boxd-attempt-machine-sources/`](./boxd-attempt-machine-sources/). They
read `BOXD_API_KEY`, or a dotenv file named by `BOXD_ENV_FILE`, and `BOXD_SDK_DIR` from the
environment, refuse any name without the `probe-1103-` prefix, and never print the key.

| Script | Measures |
| --- | --- |
| `restore.mjs` | Restore from a snapshot as the driver does, or with the allowlist in a machine spec; time to the first `exec`; egress that got through. |
| `template.mjs` | Template lifecycle: create, run a command, set egress, hibernate, wake, save a snapshot, delete. |
| `fork.mjs` | Fork a running or hibernated template; time to the first `exec`; what the fork carries; identity; pause of the template. |
| `checkpoint.mjs` | Checkpoint a machine, change it, restore the checkpoint in place. |
| `disk.mjs` | Persistent disk placement, attachment, and detachment rules. |
| `cost.mjs` | Metered rates and the usage of each probe machine. |
| `inventory.mjs` | Machine limit, source snapshot, and every `probe-1103-` resource; `delete` removes them. |

## Mechanisms

boxd offers six ways to get a ready machine ([sdk], README "Machines", "Machine specs", "Snapshots
and disks", "Files, ports, proxies, checkpoints"; `dist/teams.d.ts`):

- **Snapshot restore** (`CreateVmFromSnapshot`): a new machine from a saved memory and disk image.
  The request takes labels and `isolated`, or a machine spec merged over the snapshot's own spec,
  but not both. A snapshot is versioned: saving under the same name makes a new version, and new
  restores use the latest ready one.
- **Fork** (`ForkVm`): a new machine from the current memory and disk of a running or hibernated
  machine. It inherits the source's size, spec, labels (merged with the request's), networks,
  isolation (one-way), egress allowlist, SSH setting, idle timers, and delete timer, re-armed.
- **Machine spec on create**: a spec carries base, size, labels, networks, isolation, egress, env,
  secrets, and first-boot packages. With a snapshot as base, the machine is a restore of it.
- **Team default snapshot**: a per-region snapshot that new team machines boot from when a create
  names no snapshot. Setting it needs team-admin rights.
- **Persistent disk**: a disk that outlives machines and mounts in one machine at a time.
- **Checkpoint**: a full capture of one machine that restores that machine in place and is deleted
  with it.

## Snapshot restore

**Measured**, in milliseconds from the start of the create call.

| Path | Create call returns | First `exec` | Ready to use | Runs |
| --- | --- | --- | --- | --- |
| `usine-attempt`, as the driver does: restore, `SetVmEgressAllow`, both idle timers off, 1 s wait | 490 (455 to 530) | 575 (532 to 614) | 1,588 (1,558 to 1,624) | 5 |
| `usine-attempt`, allowlist, labels, and `isolated` in a spec; both idle timers off; no wait | 590 (384 to 635) | 692 (467 to 728) | 692 (467 to 728) | 5 |
| Warm snapshot (27.2 GB), as the driver does | 513 (462 to 703) | 592 (541 to 949) | 1,601 (1,555 to 1,809) | 6 |
| Warm snapshot (27.2 GB), allowlist in a spec | 515 (461 to 814) | 665 (551 to 896) | 665 (551 to 896) | 7 |

Values are medians with the range. "Ready to use" is the point at which the driver would start
the attempt: after the one-second wait in the driver's path, and at the first `exec` in the spec
path. The first `exec` succeeded on its first try in all 23 restores. The 2026-11-10 baseline in
[`boxd-exec-transport.md`](./boxd-exec-transport.md#startup-latency) was 640 ms to the first `exec`
(520 to 652).

- **Snapshot size.** A snapshot of 27.2 GB, with a warm pnpm store and two checkouts with
  `node_modules`, restores as fast as the 16.2 GB `usine-attempt`.
- **Spec path works with the API key.** `CreateVmFromSnapshot` with a spec of `version`,
  `isolated`, `labels`, and `egress` is accepted from a member API key. The create response already
  reports the allowlist in effect, the machine's `spec` records it, and the labels and isolation
  apply as with the request fields.
- **Timers.** A restored machine starts with auto-hibernate at 14,400 s and auto-suspend at 0, so
  the driver's two timer calls remain in either path. A spec has no idle timers.
- **Snapshot save.** Saving the running 27 GB template took 9.2 s and 10.4 s to `ready`. The source
  machine was paused for the whole save: its 50 ms timestamp loop stopped for 9.0 s and 10.4 s.
- **Deleting a snapshot** doesn't affect machines restored from it: a restore of the deleted
  `probe-1103-warm` kept reading its inherited `node_modules` and wrote 512 MB afterwards.

## Fork of a template

**Measured.**

| Path | Fork call returns | First `exec` | Template paused | Runs |
| --- | --- | --- | --- | --- |
| Fork of the running template | 525 (507 to 615) | 602 (588 to 718) | 438 (380 to 461) | 3 |
| Fork of the hibernated template | 80 | 962 | Stays hibernated | 1 |
| Hibernating the template | 127 (call) | 8,022 and 8,560 to `hibernated` | | 2 |

More runs, and two forks started at once, were planned. The tool permission layer of the session
denied every invocation that started several forks, so the fork rows have three runs and one run,
and parallel forks weren't measured.

What a fork carried, measured on the first fork and confirmed on the others:

- **Memory and processes.** The template's `setsid` loops kept running in each fork, with no restart:
  uptime continued from the template's. `dockerd` was running. `tailscaled` was inactive with no
  state, as `infra/boxd/build-snapshot.sh` leaves it, because the template never joined a tailnet.
- **Disk.** The repository mirror (40 MB), both checkouts with `node_modules` (2.1 GB), and the
  `usine-pnpm-store` and `usine-turbo-cache` volumes (1.8 GB) were present.
- **Machine record.** The allowlist, labels merged with the fork's own, both idle timers at 0 as set
  on the template, SSH on, and `source: { kind: "fork", name: "probe-1103-tpl" }`. The spec was
  `null`, because the template was restored without one.
- **Response.** One `ForkVm` response reported status `pending`, two reported `running`. The SDK
  warns that a fork of a machine that isn't yet `running` takes a cold-boot path and loses memory
  ([sdk], `waitUntilReady`).
- **Template pause.** Each fork of the running template stopped its 50 ms loop for 380 to 461 ms.
- **Hibernated template.** The fork of the hibernated template had its memory too: the loops ran
  and uptime continued. The template stayed `hibernated`.
- **Source deleted.** Deleting the template while its fork ran left the fork working: it read its
  inherited checkout and wrote 512 MB.

## Egress before anything runs

**Measured** with the template's loop that requests `example.com` at a fixed address every 100 ms
and logs the HTTP code, and an uncached DNS query. A line with HTTP 200 after the create or fork
call started is a request that the allowlist should have stopped. Times are machine clock minus the
client's start time; the machine clock ran 54 to 74 ms ahead, within the round-trip time.

| Path | Requests outside the allowlist that got through | Runs |
| --- | --- | --- |
| Restore, `SetVmEgressAllow` after the create (driver) | HTTP 200 at +697 and +845, +778 and +941, +855 and +1,019 ms | 3 of 3 |
| Restore, allowlist in the spec | HTTP 200 at +741 and +894 ms; first `exec` at +665 ms | 1 of 4 |
| Fork of the running template | HTTP 200 by address at +509 ms (1 run); by name, with the name resolved, at +550 ms and once at a time the probe didn't record (2 runs) | 3 of 3 |
| Fork of the hibernated template | None; the first logged request was blocked at +813 ms | 0 of 1 |
| Checkpoint restore in place | None | 0 of 3 |

The driver's path admits the snapshot's resumed processes for about a second by design, as ADR 0029
records. The spec path closes most of that window but not all of it: in one of four restores, a
resumed process reached a forbidden address after the first `exec` had answered, so an attempt
command started at once could have done the same. A fork of a running template inherited the
allowlist on paper and leaked in every run. The DNS column of the loop failed in every line, even
in the unrestricted second after a driver restore, so it says nothing about DNS filtering; the
name-based loop of the first two forks shows that a forbidden name resolved in a fork.

What runs in that window are the source's own processes. In `usine-attempt` that's `dockerd` and
system services; the snapshot builder stops `tailscaled`, and no attempt process runs before the
driver's first `exec`. The window matters for any process a snapshot or template keeps running, and
for the first attempt command when the driver doesn't wait.

### Egress from birth

**Measured** by the operator on 2026-11-11, after
[#1161](https://github.com/basaltbytes/usine/pull/1161), with a snapshot built by
`infra/boxd/build-snapshot.mjs`. This probe answers [question 23](#questions-for-boxd): the
allowlist isn't in force when a restore resumes, even when the snapshot and the restore request both
carry it ([issue #1196](https://github.com/basaltbytes/usine/issues/1196)).

- Snapshot `usine-attempt-2` was built from a machine whose spec lists the 25-entry egress
  allowlist. The builder checks that boxd recorded the list in the spec.
- The probe's source was a machine restored from `usine-attempt-2` with the same list in its spec,
  running the leak loop of [`fork.mjs`](./boxd-attempt-machine-sources/fork.mjs): every 100 ms, an
  HTTPS request to `example.com` at a fixed address, and an uncached DNS query. That machine was
  saved as a second snapshot.
- That snapshot was restored six times with `restore.mjs <suffix> spec`, which puts the allowlist in
  the spec of the restore request too. Times are from the start of the create call.

| Restore | First `exec` | Requests outside the allowlist that got through (ms after start: HTTP code) |
| --- | --- | --- |
| 1 | 719 ms | None in 2 attempts |
| 2 | 678 ms | None in 3 attempts |
| 3 | 710 ms | +630: 200, +833: 200 |
| 4 | 841 ms | +728: 200, +925: 200, +1,086: 200 |
| 5 | 790 ms | +710: 200, +903: 200 |
| 6 | 960 ms | +861: 200, +1,062: 200, +1,215: 200 |

- In four of six restores, a resumed process reached a host outside the allowlist for up to 1.2 s
  after the create call started. DNS for the name stayed blocked in every sample; the requests that
  got through went to a fixed address with the name as SNI.
- Every create response already reported the 25 entries in `egressAllow`, so boxd reports the list
  before it enforces it.
- At the first `exec` through the probe, 0.7 to 1.0 s after the start, `example.com` by name was
  blocked and `registry.npmjs.org` answered 200 in all six restores.
- The last request that got through came about 650 ms after the create response. The driver waits
  one second after that response before it connects, so the wait covered every sample, with a
  margin of about 350 ms over six samples. The wait stays at one second.

## Identity and isolation

**Measured** on two restores of `usine-attempt`, the template, and a fork of it.

| Property | Restores of one snapshot | Fork and its template |
| --- | --- | --- |
| Hostname | The new machine's name | The new machine's name |
| `/etc/machine-id` | Same on all | Same as the template |
| `/proc/sys/kernel/random/boot_id` | Same on all | Same as the template |
| SSH host keys | Same on all | Same as the template |
| Docker engine ID | Same on all | Same as the template |
| `boxd_ip` | `10.31.90.151` on all | `10.31.90.151` on both |
| `BOXD_VM_ID` | The new machine's id | The new machine's id |
| Uptime | Continues the snapshot's (6.3 days) | Continues the template's |
| `/dev/urandom` | Differs | Differs |
| Kernel log | `random: crng reseeded due to virtual machine fork` once per restore | The same, once per fork |
| Clock | Within the round-trip time of the client (54 to 74 ms ahead, RTT 49 to 89 ms) | Same |
| Tailscale | `tailscaled` inactive, no state file | Same |
| Isolation | Inherited from the snapshot, can only be added | Inherited from the template, can only be added |

So a fork and a restore are the same kind of copy: a resumed memory image. Both reseed the kernel's
random generator on resume, so keys generated after resume are unique. Both keep every identifier
that the guest wrote to disk or memory before the capture. None of those matter to usine today:
`Exec` doesn't use SSH host keys, Tailscale keeps its node key in its state file, which the source
must not have, and Docker's engine ID isn't used across machines. A source that ever ran
`tailscale up` would give every copy the same node key, so the template or snapshot builder must
never join.

## Warm caches

**Measured** on the template, inside the attempt image, with this repository (pnpm 11.20.0).

| Step | Cold | Warm |
| --- | --- | --- |
| Repository | 2.9 s for `git clone --mirror` from GitHub (40 MB) | 0.35 and 0.48 s for a checkout from the local mirror |
| `pnpm install --frozen-lockfile` | 45.4 s, store grows to 1.8 GB | 26.4 s |
| `turbo run build --filter=@usine/executor...` (6 tasks) | 14.7 s | 1.2 s, 6 of 6 cached |

A fork carried the mirror, the store, and the Turbo cache, and so did a restore of a snapshot saved
from the template. Either source starts an attempt with these caches; what differs is how they stay
fresh.

- **Snapshot.** A builder machine fetches, installs, and saves the snapshot under the same name,
  which makes a new version. Machines created afterwards get it; running machines and earlier
  restores don't change. The save pauses only the builder.
- **Running template.** Fetching or installing on the template reaches the next fork at once. A
  fork taken during an update gets the update half done, with the updating process still running
  in the fork.
- **Hibernated template.** It has to be woken to update, then hibernated again (8 s).

**Persistent disks don't fit.** Measured with `disk.mjs`:

- A disk lives on one boxd worker host. Attaching it to a machine on another host fails: "disk is
  on worker worker-14, VM is on worker worker-4 — create the VM with this disk in config.volumes".
- A restore can't take `config.volumes`: "This operation isn't supported yet: config.volumes when
  creating from a snapshot".
- A second attachment fails while the first exists, read-only or not ([sdk], `Disks.attach`
  documents the same). Detaching needs the machine stopped.

A shared cache disk would therefore serve one attempt at a time and would need a stop for every
hand-over.

## Checkpoints

**Measured** on the fork of the hibernated template.

| Step | Result |
| --- | --- |
| `CreateCheckpoint` to `ready` | 19.3 s; the machine was paused for 18.4 s; 27.2 GB |
| Restore in place | 722 ms (659 to 792), 3 runs |
| Restore to first `exec` | 938 ms (924 to 1,116) |
| State after restore | Files and containers made after the checkpoint were gone; the loops kept running from the checkpoint; the allowlist stayed in force, with no request outside it |

A checkpoint resets a reused machine to a known state in under a second, without the cleanup sweep
of `provisioner.reuse`. It costs the 18 s pause once per machine, belongs to that machine, and is
unavailable after the machine migrates to another host ([sdk], `Checkpoint.available`). A restore
from a warm snapshot reaches the same clean state in 0.7 s on a new machine.

## Cost and limits

**Measured** with `cost.mjs` and `inventory.mjs`.

- **Rates** for this org: EUR 0.039 per vCPU-hour of CPU time used, EUR 0.012 per GiB-hour of
  resident RAM while running or in standby, and EUR 0.00008 per GiB-hour of used disk in every
  state. CPU and RAM are what the guest uses, not its size: the account's other hibernated machine,
  a 2x8, used 3.2 GiB-hours of RAM over 8 hours running.
- **Hibernated machine**: disk only. The hibernated fork, with 17 GB used on its disk, was metered
  18.1 GiB of disk over 899 s of hibernation and no RAM: EUR 0.0014 per hour, about EUR 1.06 a
  month. Whether the memory image is in those 18.1 GiB isn't visible (see
  [question 26](#questions-for-boxd)). The account's other hibernated machine was metered 7.5 GiB
  over the same window.
- **Waking**: the hibernated fork answered its first `exec` 1.35 s after `wake`, with its loops
  still running.
- **Snapshot storage**: neither the SDK nor the usage report shows it. `usine-attempt` holds
  16.2 GB.
- **Machine limit**: this org may have 100 machines. A hibernated machine counts: the count was 2
  with two hibernated machines. A template takes one slot per worker in every state.
- **Template lifetime**: the SDK documents no limit on how long a machine stays hibernated or
  forkable. Not measured beyond 18 minutes of hibernation.
- **Probe cost**: EUR 0.015 metered for all probes at 01:37 UTC, with metering still incomplete;
  under EUR 0.03 by the running times.

## Failure modes

| Failure | Snapshot restore | Fork of a template |
| --- | --- | --- |
| Source deleted | New creates fail; existing machines keep working (measured). | New forks fail; existing forks keep working (measured). |
| Source broken (full disk, wedged `dockerd`, bad update) | A broken build is one version: new restores get it at once, machines already restored keep theirs, and the next build replaces it. Saving under a new name and then changing the worker's `snapshot` setting stages a build. | Every fork inherits the live breakage until someone repairs the template. |
| Source changed while copying | A save pauses the builder for the whole save, so the image is consistent (measured: 9 to 10 s pause). | A fork pauses the template for about 0.4 s and copies whatever is in flight, such as a half-done install. |
| Source busy | No effect on restores. | Each fork pauses the template; a template that runs updates sees a pause per fork. |
| Source not `running` | Not applicable. | A fork of a `pending` machine cold-boots and loses memory ([sdk], `waitUntilReady`). |
| Host migration | A snapshot is replicated on several hosts ([sdk], `Snapshots`). | Not measured; whether a fork of a `migrating` machine waits, fails, or cold-boots isn't documented. |
| Region | A snapshot lives in one region; the driver checks it in `verify`. | A template lives in one region too; one template per region and worker. |
| Archived source | Restores are refused while a snapshot is archived ([sdk], `SnapshotInfo.storage`). `verify` checks only `status`. | Not applicable. |

## Comparison

| Goal | Snapshot restore, driver as built | Snapshot restore, allowlist in a spec | Fork of a running template | Fork of a hibernated template |
| --- | --- | --- | --- | --- |
| Time to ready | 1.6 s, with the 1 s wait | 0.7 s; 1.6 s while the 1 s wait stays | 0.6 s; a wait would apply too | 1.0 s |
| Attempt image | In the snapshot | In the snapshot | On the template | On the template |
| Warm pnpm store, Turbo cache, mirror | If baked into the snapshot (measured: carried) | Same | Carried (measured) | Carried (measured) |
| Freshness of caches | New snapshot version from a builder | Same | Live, including half-done updates | After wake, update, hibernate |
| Egress before anything runs | No: about 1 s open by design (3 of 3 leaked) | No: 1 of 4 leaked for about 0.15 s after first `exec`; 4 of 6 leaked up to 1.2 s after the start with the list in the snapshot too | No: 3 of 3 leaked within 0.55 s | Yes in 1 run |
| Tailnet join | Clean if the snapshot never joined | Same | Clean if the template never joins | Same |
| Isolation | Inherited, one-way | Inherited, one-way, in the spec | Inherited, one-way | Inherited, one-way |
| State from another attempt | None | None | None if no attempt runs on the template; template drifts | Same |
| Reproducibility | Fixed per snapshot version | Same | Changes with the template | Fixed between updates |
| Extra cost | Snapshot storage (not documented) | Same | One running machine per worker and region; a machine slot | About EUR 1 a month per template and a machine slot |
| Operational parts | Builder script | Builder script | Template lifecycle, health, and repair | Template lifecycle plus wake and hibernate |

Neither a team default snapshot, a persistent disk, nor a checkpoint is a better source:

- A team default snapshot is a default for creates that name no snapshot. The driver always names
  one, so it adds nothing, and setting it is an org change. Not measured.
- A persistent disk serves one machine on one host at a time and can't be attached at restore.
- A checkpoint resets one machine in place; it's an alternative to the cleanup sweep for reused
  machines, not a source for new ones.

## Driver changes for the recommended option

No implementation here; these are the changes in terms of the existing ports.

- **`BoxdApi.createFromSnapshot`** (`provisioner/boxd/client.ts`) takes a spec instead of `labels`
  and `isolated`: `version`, `isolated`, `labels`, and `egress` when `provisioner.egress` is set.
  `BoxdCreate.config` stays. The proto projection (`proto/api.proto`) gains the `MachineSpec`
  message with those fields and the `spec` field of `CreateVmFromSnapshotRequest`.
- **`BoxdDriver.create`** (`provisioner/boxd.ts`) checks the allowlist in the create response
  (`BoxdMachine.egressAllow`, already decoded) instead of calling `restrictEgress`, and deletes the
  machine as today when it's empty. The one-second wait stays, counted from the create response
  instead of from the `SetVmEgressAllow` answer: [Egress from birth](#egress-from-birth) measured
  requests outside the list until about 650 ms after that response. The two timer calls stay.
- **`BoxdDriver.assign`** for a reused machine keeps `SetVmEgressAllow`; a reused machine already
  has the list from its spec, so the call is a check.
- **`BoxdDriver.verify`** also refuses a snapshot whose `storage` isn't `local`, which boxd refuses
  to restore.
- **`infra/boxd/build-snapshot.sh`** gains an optional cache step: mirror the configured
  repositories, run `pnpm fetch` or `pnpm install` in the attempt image against the shared volumes,
  and save under the same name to make a new version. Private repositories need a credential on the
  builder that never reaches the snapshot, which is a design question for that issue.

A fork-based driver would change more: the `snapshot` setting becomes `template`; `verify` checks
the template's status, region, size, and allowlist and counts it against the machine limit; `create`
calls `ForkVm` with labels and waits for `running`; the egress check compares the template's
allowlist with `provisioner.egress`; and a new owner, the orchestrator or an operator script, builds,
health-checks, updates, hibernates, and replaces the template in each region.

## Risks

- **Egress window on restore.** Even with the allowlist in the spec, a resumed process reached a
  forbidden address in one of four restores, after the first `exec`, and in four of six restores of
  a snapshot that carries the list itself, up to 1.2 s after the create call started. Until boxd
  enforces the list before the machine resumes (question 23), the driver can't rely on the spec
  alone.
- **Egress window on fork.** Every fork of a running template leaked. A template keeps its own
  processes running, so the window would apply on every attempt.
- **Shared identifiers.** Every machine restored from one snapshot has the same `machine-id`,
  `boot_id`, SSH host keys, and Docker engine ID. Harmless for usine today; a future component that
  keys on `machine-id` would see every attempt machine as one host.
- **Stale caches.** A warm snapshot ages until the next build. The attempt's own `git fetch` and
  `pnpm install` cover the delta, so staleness costs time, not correctness.
- **Snapshot cost unknown.** If boxd meters snapshot storage, a warm snapshot of 27 GB costs more
  than the 16 GB one; the rate isn't published.

## Questions for boxd

These continue the numbered list in
[`boxd-exec-transport.md`](./boxd-exec-transport.md#questions-for-boxd), which ended at 22.

23. When is the allowlist enforced on a restored machine, and can it be enforced before the machine
    resumes? Answered by measurement on our side, see [Egress from birth](#egress-from-birth): with
    the allowlist in the spec of both the snapshot and `CreateVmFromSnapshot`, a resumed process
    reached a host outside the list in four of six restores, up to 1.2 s after the create call
    started and about 650 ms after the create response, which already reported the list in
    `egressAllow`. An earlier run saw the same in one of four restores, 0.74 and 0.89 s after the
    start, after the first `exec` had answered.
24. A fork inherits its source's allowlist, but in three of three forks of a running machine a
    process reached a forbidden host within 0.55 s. Is the allowlist applied before the fork
    resumes, and can it be?
25. Is snapshot storage billed, at what rate, and where does it show in usage or billing activity?
26. Is the memory image of a hibernated machine metered as disk?
27. How long does a hibernated machine stay hibernated and forkable? Can boxd archive or migrate
    it, and what does `ForkVm` do with a source that is `migrating`?
28. Does a fork depend on its source after `ForkVm` returns? A fork kept working after its source
    was deleted; does that hold across host migration?
29. Does each fork pause the source (380 to 461 ms measured on a 2x8 machine), does the pause grow
    with memory, and can forks of one source run in parallel?
30. Is a full pause of the source for the whole snapshot save (9 to 10 s for 27 GB) and checkpoint
    (18 s) expected?
31. Could restores and forks get a new `/etc/machine-id` and `boot_id`, as a first boot would, or
    should guests regenerate them?
32. Every restore reports `boxd_ip` `10.31.90.151`. Is that address private to each isolated
    machine, and can it collide on a shared network?
33. Are read-only attachments of one disk to several machines, disk clones, or `config.volumes` on
    a snapshot restore planned?
34. A hibernated machine counted toward the machine limit. Is that permanent, or could a machine
    kept only as a fork source be exempt?

## Recommendation

Keep snapshot restores as the source of attempt machines, and don't adopt fork-based templates.

- A fork of a running template saves about 0.1 s over a restore with the allowlist in the spec,
  and a fork of a hibernated template is slower. Both are small next to warm caches, which save
  about 19 s of `pnpm install` and 13 s of Turbo build on this repository.
- A snapshot carries the same caches, restores as fast at 27 GB as at 16 GB, and stays fixed per
  version, while a template drifts, pauses on every fork, needs a machine slot in every state, and
  passes any breakage to every fork. Every fork of a running template leaked egress.
- The better tool for the egress goal is the machine spec on `CreateVmFromSnapshot`: the allowlist
  arrives with the create request and the create response confirms it. It doesn't close the
  window: boxd enforces the list up to about 650 ms after the create response, which the driver's
  one-second wait covers, and boxd should close it (question 23).

Move the allowlist, labels, and isolation into the create request's spec, keep the one-second wait
until boxd enforces the allowlist before a restored machine resumes (question 23), refuse archived snapshots in `verify`, and add an optional cache
step to the snapshot builder as a separate issue. Revisit forks if boxd closes the fork egress
window and the factory runs enough attempts per hour that a long-lived template's warmth beats a
nightly snapshot build.

## Cleanup

`inventory.mjs` at 2026-11-11T01:37Z listed no machine, snapshot, or disk named `probe-1103-`:
one machine in the org (hibernated, not a probe), one snapshot (`usine-attempt`), and no disks.
`checkpoint.mjs` deleted its checkpoint, and checkpoints are deleted with their machine.

## Sources

- `@boxd-sh/sdk` 0.3.0 on npm ([sdk]): `README.md` sections "Machines", "Creating", "Machine
  specs", "Packages", "Egress allowlist", "Labels", "Sizing", "The `Machine` record", "Files,
  ports, proxies, checkpoints", "Snapshots and disks", "Organizations", and "Usage and cost";
  `dist/machines.d.ts`, `dist/machines.js`, `dist/teams.d.ts`, `dist/checkpoints.d.ts`,
  `dist/disks.d.ts`, `dist/backups.d.ts`, `dist/snapshots.d.ts`, `dist/spec.d.ts`,
  `dist/models.d.ts`, and `dist/_generated/api.d.ts` (`ForkVmRequest`,
  `CreateVmFromSnapshotRequest`, `SnapshotInfo`).
- usine: `packages/executor/src/ssh/provisioner/` (`boxd.ts`, `boxd/client.ts`, `boxd/exec.ts`,
  `model.ts`, `reuse.ts`, `tailnet/bootstrap.ts`), `infra/boxd/build-snapshot.sh`,
  `apps/docs/src/content/docs/guides/add-a-boxd-worker.md`, ADR 0029,
  [`boxd-exec-transport.md`](./boxd-exec-transport.md), and [`boxd-byoc.md`](./boxd-byoc.md).
- Issues and pull requests: [#1083](https://github.com/basaltbytes/usine/issues/1083),
  [#1103](https://github.com/basaltbytes/usine/issues/1103), and
  [#1128](https://github.com/basaltbytes/usine/pull/1128).

[sdk]: https://www.npmjs.com/package/@boxd-sh/sdk/v/0.3.0

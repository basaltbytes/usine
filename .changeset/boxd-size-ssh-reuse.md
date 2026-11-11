---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

boxd workers follow how boxd restores machines. `provisioner.size` is optional and takes any `<vcpu>x<GiB>` size, such as `1x32` on a self-hosted cluster, instead of the hosted sizes only. A restore keeps its snapshot's size, so the setting only asserts it: when it is set, preflight compares the snapshot's vCPU count and memory with it and names the snapshot's size on a mismatch. Without it, preflight accepts the snapshot's size. Preflight logs the snapshot's size in `boxd provisioner verified`. `BoxdSize` is a branded `<vcpu>x<GiB>` string, and the operator view reports a missing size as null. `infra/boxd/build-snapshot.mjs --size` takes the same pattern and puts it in the temporary machine's spec.

Each boxd machine is created with SSH off, since usine runs every command through `Exec`. A boxd worker ignores `provisioner.reuse`: boxd restores a machine in under a second, so every attempt gets a new machine. A stored worker that sets it still loads, and preflight warns that it has no effect and names the worker. The executor's `BoxdProvisioner` has no reuse policy and reports the ignored setting as `ignoredReuse`, `MachineDriver.assign` is optional and absent from the boxd driver, and the boxd client no longer updates labels.

---
"@usine/config": minor
"@usine/executor": minor
"@usine/server": patch
---

`@usine/config` and `@usine/executor/ssh` no longer export the deprecated `BoatTailnet` alias. Use `ProvisionerTailnet`.

A boxd `Exec` call takes its exit code from the last response only: one without data, or one with a non-zero exit code. A call whose last response is output fails as unreachable, even after an earlier empty response, and a last response that carries output and an exit code keeps both. Error messages stay readable when the boxd credential is empty. A dead `Exec` connection fails within 50 seconds by default.

`infra/boxd/build-snapshot.mjs --no-isolated` builds a snapshot without isolation. A machine restored from an isolated snapshot is always isolated, so a worker's `isolated: false` takes effect only with such a snapshot.

The worker page shows a boxd worker's region, snapshot, size, and isolation, with the default that applies when a setting is empty.

# @usine/run-host

The worker-side process for one [usine](https://github.com/basaltbytes/usine) Attempt. Installations receive the `usine-run-host` executable; embedders can import its absolute Node command from `@usine/run-host/executable`.

The host speaks protocol v2 as newline-delimited JSON. Its first input must be a secret-free `Start` frame containing the repository, payload snapshot, rendered task, named agent, and effective parent model. It emits `Started` followed by normalized parent and child `Activity` envelopes, accepts steer or interrupt envelopes, then closes with one `Final`, `Failed`, or `Interrupted` envelope. `usine-run-host --protocol-version` prints the supported wire version for worker preflight checks.

The executable runs the production Pi parent and Claude child layer. `--stub` and `--stub-delay-ms` select the deterministic adapter used by process tests. Runtime logs go to stderr because stdout belongs exclusively to the attempt channel.

After the agent session finishes, the host records commits created after the supplied base commit. A final result contains the agent message and structured commit facts; pull-request and comment facts use the same `StepResult` union.

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

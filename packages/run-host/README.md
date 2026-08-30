# @usine/run-host

The worker-side process for one [usine](https://github.com/basaltbytes/usine) Attempt. Installations receive the `usine-run-host` executable; embedders can import its absolute Node command from `@usine/run-host/executable`.

The host speaks protocol v1 as newline-delimited JSON. Its first input must be a secret-free `Start` frame. It emits `Started` and agent-message envelopes, accepts steer or interrupt envelopes, then closes with one `Final` or `Failed` envelope. `usine-run-host --protocol-version` prints the supported wire version for worker preflight checks.

The default `runHost` Effect runs a deterministic stub agent and records commits created after the supplied base commit. A final result contains the agent message and structured commit facts; pull-request and comment facts use the same `StepResult` union.

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

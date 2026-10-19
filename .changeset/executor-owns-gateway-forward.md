---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
---

The executor opens and keeps its own SSH forward to a Gateway's admin API (#249).

`@usine/core/worker`: `GatewayAdminPort`, the port of a Gateway's admin API on the Gateway.

`@usine/config/factory`: `gateway.destination` and `gateway.admin_port` name where the executor opens its forward to the admin API, in place of a URL.

`@usine/executor/ssh`: `SshWorkerGateway` takes `destination` and `adminPort` in place of `adminUrl`. When the layer is built, the executor opens one forward to each Gateway's admin API, `ssh -N -L` with the SSH command and environment of its other SSH clients, on a local port of 127.0.0.1 that the kernel picks. When the SSH client exits, it starts another one after a pause of one second that doubles up to one minute, and it closes the forward with the layer. An admin request that finds the forward closed, or gets no answer through it, has the forward reopened at once and is sent once more; a second failure fails the request with a message that says since when the forward has been closed. Preflight checks that the forward opens, and reports the `ssh` command to run when it does not.

`@usine/orchestrator/ssh`: `sshWorkerAddressesOf(config)` passes each Gateway's destination and admin port to the executor.

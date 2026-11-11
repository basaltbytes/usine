---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

boxd workers accept `provisioner.egress`, the complete egress allowlist of each machine: host names, `*.` wildcards, public IPv4 addresses or CIDR ranges of at most `/8`, or `none`. Like boxd, the configuration refuses an address with host bits set or one in a private, CGNAT, loopback, link-local, multicast, or reserved range. The driver sends it in the machine spec of the restore request, so each machine is created with it, and waits one second before it connects to the machine: processes that the snapshot resumes can reach hosts outside the list for up to about a second. If boxd reports the new machine unrestricted, the driver deletes the machine and retries creation. A reused machine gets the list again. Without `egress`, machines keep unrestricted egress.

Behind a gateway, the configuration is refused when the list omits `*.tailscale.com`, or admits `github.com`, `api.github.com`, or the API and login hosts of a provider in `gateway.llm_providers`. Address entries aren't checked against the gateway; preflight logs a warning that names them. The operator view and the worker form show the list. `infra/boxd/egress.mjs` prints the gateway's `egress-allowlist` as `provisioner.egress`, so both enforcement points use one list.

---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

boxd workers accept `provisioner.egress`, the complete egress allowlist of each machine: host names, `*.` wildcards, IPv4 addresses or CIDR ranges, or `none`. The driver applies it with `SetVmEgressAllow` right after the restore and waits one second for boxd to enforce it before it connects to the machine. If boxd refuses the list or reports the machine unrestricted, the driver deletes the machine and retries creation. A reused machine gets the current list again, or an unrestricted one when `egress` is unset. Without `egress`, machines keep unrestricted egress.

Behind a gateway, the configuration is refused when the list omits `*.tailscale.com`, or admits `github.com`, `api.github.com`, or the login hosts of a provider in `gateway.llm_providers`. The operator view and the worker form show the list. `infra/boxd/egress.mjs` prints the gateway's `egress-allowlist` as `provisioner.egress`, so both enforcement points use one list.

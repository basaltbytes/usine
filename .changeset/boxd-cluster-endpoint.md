---
"@usine/core": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

boxd workers connect to any boxd cluster. `provisioner.endpoint` sets the cluster's account endpoint, such as `https://boxd.example.com:9443`, and defaults to the hosted service at `https://boxd.sh:9443`. The driver sends account calls and `ListRegions` there, and derives the token exchange URL from it as the boxd SDK does: `https://app.<host>/api/v1/auth/token`, without the port, or the endpoint itself for a `localhost`, IP address, or `app.` host.

`provisioner.region` is optional and no longer defaults to `fra`. Without it, every call goes to the endpoint, and machines start where the endpoint runs them: Frankfurt on the hosted service, or the only location of a self-hosted cluster. A region that the endpoint serves itself needs no API endpoint in the region listing. Preflight compares the snapshot's region with the region that boxd serves, and fails with advice to remove `provisioner.region` when a cluster that runs in one place lists no regions.

Over TLS or to a loopback address, the driver sends the API key as the bearer. It falls back to the token exchange when boxd refuses the key as a bearer, and keeps renewing the session and retrying a call once on `UNAUTHENTICATED`. `Exec` calls carry the session too once boxd refuses the key, so a cluster behind a load balancer that terminates TLS runs commands. `provisioner.endpoint` accepts `http://` only for `localhost`, `127.0.0.0/8`, or `[::1]`, and a port only from 1 to 65535. The driver refuses to connect to a region that boxd lists at an `http://` API endpoint on another host. When boxd doesn't answer or rate-limits, the error names the URL that usine called. The operator view and the worker form show the endpoint, and the view reports a missing region as null.

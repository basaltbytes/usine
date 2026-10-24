---
"@usine/gateway": minor
---

`git.<domain>` serves release downloads at `/OWNER/REPO/releases/download/TAG/FILE` and `/OWNER/REPO/releases/latest/download/FILE` for the attached repository, with the installation token as the `x-access-token` password. The gateway returns GitHub's redirect to the asset host unchanged, so `curl -L` on a worker fetches the asset through the forward proxy and the token reaches only github.com. A release download for another repository is refused with `repository-mismatch`.

The gateway rewrites a `Location` header that points at github.com or api.github.com to `http://git.<domain>`, with API paths under `/api/v3`, and keeps the path and query, so a worker follows GitHub's redirects for a renamed repository through the gateway. `Location` headers on other hosts pass unchanged. Each release download logs `Served a GitHub release download`, each rewrite logs `Rewrote a GitHub Location header to the gateway`, and a forwarded response's log line has its `Location` host as `target`, without the path or query string.

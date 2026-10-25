---
"@usine/gateway": patch
---

The `unknown-host` refusal for a host on the egress allowlist says to download with `curl -fL -u ":$GH_TOKEN"` from `git.<domain>` instead, with the release download and archive URLs. gh gets this refusal when it follows GitHub's redirect to a download host through its socket, as in `gh release download`.

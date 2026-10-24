---
"@usine/server": patch
---

A reload whose new or changed agent's brain fails worker preflight returns 409 `ReloadPreflightError` and keeps the running configuration. After an accepted reload, polling starts at once.

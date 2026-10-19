---
"@usine/server": patch
---

A reload whose new or changed Agent uses a brain that fails Worker preflight answers 409 `ReloadPreflightError` and keeps the running configuration; the message names the Agents and the failed check. After an accepted reload, the next poll starts at once.

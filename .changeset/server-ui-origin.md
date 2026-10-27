---
"@usine/server": minor
---

`usine up --origin <url>`, or `USINE_ORIGIN`, names the URL at which a proxy publishes the UI, such as the HTTPS URL of `tailscale serve` ([#609](https://github.com/basaltbytes/usine/issues/609)). The operator API accepts browser requests from pages at that origin, as it does from the loopback names, and refuses other origins. The server still listens only on `127.0.0.1`. `usine up` records the origin in `.usine/instance.json`, so `usine restart` passes it again, and `usine status` shows it.

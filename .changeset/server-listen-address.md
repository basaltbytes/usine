---
"@usine/server": minor
---

`usine up --listen <address>`, or `USINE_LISTEN`, makes the server also listen on one more IP address at the same port, such as the machine's tailnet address ([#609](https://github.com/basaltbytes/usine/issues/609)). The operator API accepts browser requests from pages at that address, as it does from the loopback names, and refuses other origins. `usine up` refuses `0.0.0.0`, `::`, and `127.0.0.1`, checks the port at both addresses before it starts, and records the address in `.usine/instance.json`, so `usine restart` passes it again. `usine status` lists both URLs.

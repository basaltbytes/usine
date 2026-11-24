---
"@usine/core": minor
"@usine/gateway": minor
"@usine/executor": patch
---

The model provider catalog refuses entries that could send a key to the wrong place, the gateway's provider report stays readable by orchestrators from before the catalog, and the gateway ignores a stored credential under the wrong slot.

- `@usine/core/agent/provider`: a catalog refuses two providers that read the same credential or upstream variable. `KeyHeader` refuses a hop-by-hop header or one that frames the body, such as `host`, `connection`, `transfer-encoding`, `content-type`, or `content-length`. `ModelProvider` refuses two protocols whose routes can match one path. `RoutePattern` refuses a `.` or `..` segment, and two placeholders in one segment without a literal between them. `ProviderProtocol.serves` compiles its routes once and matches a path in time linear in its length. `HOP_BY_HOP_HEADERS` lists the headers that a proxy never forwards; `routeServes` is removed.
- `@usine/gateway`: `GET /v1/providers` reports each slot's credential kind as `credential` on its entry in `slots`, and lists in `providers` only `anthropic-messages` and `openai-responses`, so a third slot with a credential no longer fails the read of an orchestrator from before the catalog. The gateway ignores a record in `provider-credentials.json` under a slot whose provider doesn't accept it, and logs the slot and the record's kind at Warning.
- `@usine/executor`: the gateway preflight reads each slot's credential kind from `slots` when the gateway reports it there, and from `providers` otherwise.

---
"@usine/agents": minor
"@usine/core": minor
"@usine/durable": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Billing pools are data that each harness declares in the harness catalog, so a harness or a login with its own plan adds its pool without changes to usage, statistics, plan windows, or the web app. The pools that usine records stay the same: API keys, the Claude plan, and the ChatGPT plan, and stored records read as before.

Usage and statistics list pools in catalog order under the labels that the catalog declares, and price usage in a plan pool as an estimate. `GET /api/configuration/capabilities` returns the catalog's `pools`, and usage, statistics, and pool warnings return each pool's `label`. A pool that the catalog doesn't declare, such as one of a removed harness, follows the declared pools under its ID.

- `@usine/core/agent/pool`: `BillingPool` moves here from `/agent/session` and becomes a branded camelCase ID that validates syntax only, like `Harness`. `PoolDescriptor` declares a pool's `id`, `label`, `billing` (`plan` or `metered`), and `windows` (`none`, `together`, or `separately`). `BillingPools` is a `Context.Reference` to the catalog's pools; without it, no pool is declared.
- `@usine/agents/harness`: `HarnessDescriptor.pools` lists the descriptor's `HarnessPool`s, each a pool and the credential routes that determine it at admission, and `HarnessCatalog.pools` lists each declared pool once, in catalog order. The catalog refuses a pool ID that two harnesses define differently. `/pi/authentication` exports `piLoginPools`, the plan pool of each Pi subscription login that usine accepts; `requiredPiPool` and `resolvePiPool` return a `BillingPool`, and `PiPool` is removed.
- `@usine/engine`: `RunStore` keeps an omitted window of a pool whose windows are reported `separately` in `BillingPools`, as it kept Claude plan windows before.
- `@usine/orchestrator/operator`: `PoolUsageView`, `TaskPoolUsageView`, `PoolTokensView`, and `PoolLimitNeed` have a `label`. Usage, statistics, and pool warnings read the pools from `BillingPools`.
- `@usine/server`: provides `BillingPools` from the harness catalog for the server's lifetime.

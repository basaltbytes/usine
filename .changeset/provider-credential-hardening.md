---
"@usine/core": minor
"@usine/gateway": minor
"@usine/cloudflare": minor
---

The gateway and the Cloudflare outbound handlers close the ways that a later change or a careless setting could send a provider key or a caller token to the wrong host.

- `@usine/gateway`: an upstream variable, such as `USINE_GATEWAY_OPENAI_UPSTREAM` or `USINE_GATEWAY_CHATGPT_UPSTREAM`, takes an `https://` URL, or an `http://` URL to a loopback host only. Another `http://` URL fails the startup, and a reload with one keeps the provider settings in force, with an error that names the variable. A provider slot refuses a method that the route's entry doesn't list with `unsupported-path`, as the Cloudflare handler does. The `key` query parameter no longer reaches a provider's upstream. `provider-credentials.json` records the provider ID of each key under `staticKeys`, and the gateway ignores, with a warning, a key saved for another provider than its slot's; a key saved without an ID still loads. A saved Anthropic or OpenAI key, and a saved Claude setup token, load only for the built-in `anthropic` or `openai` provider, and a Claude login connects only to `anthropic`, so a catalog that gives a built-in slot or the `claude` login to another provider never sends it those credentials.
- `@usine/cloudflare`: `ProviderProps` carries the provider's ID instead of its entry, and reads the props that earlier Workers registered for the entry's ID. `providerOutbound` takes the Worker's catalog and reads the entry from it on each request, so a handler that a container keeps across a deployment serves the current entry. It refuses a provider that the catalog no longer serves in a sandbox, or props that it can't decode, with status 403. `providerRequest` takes the catalog and leaves out `cookie`, the key header of every catalog provider, and the `key` query parameter.
- `@usine/core/agent/provider`: `upstreamSearch` returns a query without the parameters that can carry a key, and `ModelProviderCatalog.keyHeaders` lists the header that each protocol takes its key in.

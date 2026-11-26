# The gateway holds worker credentials and, on its private network, is the only way out

Workers run agent code, so a gateway holds their credentials and, on its private network, is their only destination: SSH bastion, DNS resolver, time server, reverse proxy to GitHub and model providers, and forward proxy to allowlisted hosts. A compromised attempt can use only what the executor attached for it (ADR 0011), while attached, through the gateway.

- **Caller tokens, not addresses.** Private addresses may be spoofable, so each attempt sends a gateway-signed token naming its attachment, worker, and repository, valid while attached.
- **Credentials at the gateway.** A refresh invalidates every copy of a login, and attempts can read a machine's login, so the gateway swaps the caller token for the credential in a provider's slot. Otherwise a harness uses its machine's login or an attempt API key.
- **Providers from a bundled catalog.** Each model provider is one entry in `@usine/core`. The gateway serves its release's entries and takes no upstream from the orchestrator, which could then send a key to any host; preflight asks to upgrade a gateway that lacks a slot or route.
- **Keys connected by entry.** The admin API connects a static key for any entry that takes one; the gateway implements each subscription login, a Claude setup token that the operator replaces or a ChatGPT login that it refreshes, so logins stay a closed set. Saved credentials keep older gateways' format where it fits, so downgrades keep the built-in providers.
- **Tunnels pinned to names.** A tunnel opens only if the TLS server name matches the CONNECT host. Tunnels keep caller tokens, so the allowlist omits GitHub and gateway-held providers' hosts; fixed GitHub download redirects go to unlisted hosts without credentials.
- **Plain HTTP to the gateway.** TLS would need a certificate authority on every worker, so traffic crosses the private network unencrypted.
- **The operator's credential.** A gateway serves only its operator's agents: Anthropic's terms, read on 2026-10-26, forbid relaying other people's subscription logins.

Workers off the private network reach it over Tailscale, which keeps credentials off them but doesn't limit egress (ADR 0029).

## Considered options

- **Envoy `credential_injector`**: one static credential per route, changed at each attach and detach.
- **A TLS-intercepting proxy**: a gateway compromise could read all worker TLS.
- **Credentials on the worker behind a firewall**: the token and keys stay on the machine.
- **Providers sent by the orchestrator**: no gateway upgrade per provider, but the admin token chooses where keys go.

# The gateway holds worker credentials and, on its private network, is the only way out

Workers run agent code, so a gateway holds their credentials: the executor attaches each attempt's installation token for the attempt's lifetime (ADR 0011). The reverse proxy adds that token to GitHub requests and a provider's credential to model requests; the forward proxy reaches allowlisted package hosts. On its private network, the gateway is also the workers' SSH bastion, DNS resolver, time server, and only destination.

A compromised attempt can use only what is attached, while attached, through the gateway.

- **Caller tokens, not addresses.** Private addresses may be spoofable, so each attempt sends a gateway-signed token naming its attachment, worker, and repository, refused once the attachment ends.
- **Subscriptions at the gateway.** A refresh invalidates every copy of a harness login, and a long-lived machine's login is readable by its attempts, so the gateway swaps the caller token for the subscription or API key in a provider's slot. Without it, a harness uses its machine's login or an attempt API key.
- **Providers from a bundled catalog.** Each model provider is one entry in `@usine/core`. The gateway serves its own release's entries and takes no upstream from the orchestrator, which could otherwise send a key to any host. Preflight asks for a gateway upgrade when a slot or route that the orchestrator uses is missing.
- **Tunnels pinned to names.** A tunnel opens only if the TLS server name matches the CONNECT host. Tunnels keep caller tokens, so the allowlist must omit github.com and gateway-held providers' hosts. For fixed GitHub download paths, the gateway follows redirects to unlisted hosts without credentials.
- **Plain HTTP to the gateway.** TLS would need a certificate authority on every worker, so traffic crosses the private network in the clear.
- **The operator's credential.** A gateway serves only its operator's agents: Anthropic's terms, read on 2026-10-26, forbid relaying other people's subscription logins.

Workers off the private network reach the gateway over Tailscale, which keeps credentials off them but doesn't limit their egress (ADR 0029).

## Considered options

- **Envoy `credential_injector`**: one static credential per route, changed at each attach and detach.
- **A TLS-intercepting proxy**: a gateway compromise could read all worker TLS.
- **Credentials on the worker behind a firewall**: the token and keys stay on the machine.
- **Providers sent by the orchestrator**: no gateway upgrade per provider, but the admin token chooses where keys go.

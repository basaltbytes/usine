# The gateway holds worker credentials and, on its private network, is the only way out

Workers run agent code, so a gateway holds their credentials: the executor attaches each attempt's installation token to the gateway at preparation and detaches it at cleanup (ADR 0011). The gateway's reverse proxy adds that token to GitHub requests and its model credential to model requests; its forward proxy reaches allowlisted package hosts. On its private network, the gateway is also the workers' SSH bastion, DNS resolver, time server, and attempts' only destination.

A compromised attempt can use only what is attached, while attached, through the gateway.

- **Caller tokens, not addresses.** Private addresses may be spoofable, so each attempt sends a gateway-signed token naming its attachment, worker, and repository, refused once the attachment ends.
- **Subscriptions at the gateway.** A machine made for one attempt can't keep a harness login, because one refresh invalidates every copy, and a long-lived machine's login is readable by its attempts. The gateway swaps the caller token for a subscription credential or an API key per wire-protocol slot and serves only the harnesses' routes. Without the gateway's credential, a harness uses a login on the machine or an API key passed to the attempt.
- **Tunnels pinned to names.** A tunnel opens only if the TLS server name matches the CONNECT host. Tunnels can't remove caller tokens, so the allowlist must omit github.com and hosts of providers whose credential the gateway holds; the gateway doesn't check this. For fixed GitHub download paths, the gateway follows redirects to unlisted hosts without credentials.
- **Plain HTTP to the gateway.** TLS would need a certificate authority on every worker, so caller tokens, repository contents, and model traffic cross the private network in the clear.
- **The operator's credential.** A gateway serves only its operator's agents. Anthropic's terms, read on 2026-10-26, forbid third parties to store or relay other people's subscription logins, so a hosted usine holding its users' logins is the forbidden case.

Workers off the private network reach the gateway over Tailscale, which keeps credentials off them but doesn't limit their egress (ADR 0029).

## Considered options

- **Envoy `credential_injector`**: one static credential per route; usine's change at each attach and detach.
- **A TLS-intercepting proxy**: a gateway compromise could read all worker TLS.
- **Credentials on the worker behind a firewall**: the token and keys stay on the machine.

import type { GatewayDomain } from "../settings.ts";
import { type EgressAllowlist, Port } from "./egress.ts";

const HTTPS = Port.make(443);

/**
 * The dnsmasq configuration lines that answer each name the allowlist
 * permits on port 443 with `address`, the private address of the gateway's
 * transparent listener, so a Worker client that ignores proxy variables
 * connects there. A host rule becomes a `host-record`, which answers that
 * name only; a `*.domain` rule becomes an `address` for the names below the
 * domain. Each comes with a `local` line, so an AAAA query gets an empty
 * answer rather than a refusal, on which musl's resolver fails the whole
 * lookup. Every other name stays unanswered. The first line names the
 * gateway's own `domain`, because dnsmasq answers a reverse lookup of the
 * address with the first `host-record` that has it.
 */
export const dnsmasqConfiguration = (
  allowlist: EgressAllowlist,
  gateway: { readonly domain: GatewayDomain; readonly address: string },
): ReadonlyArray<string> => [
  `host-record=${gateway.domain},${gateway.address}`,
  ...allowlist.rules
    .filter((rule) => rule.ports.includes(HTTPS))
    .flatMap((rule) =>
      rule.match === "exact"
        ? [`host-record=${rule.host},${gateway.address}`, `local=/${rule.host}/`]
        : [`address=/*.${rule.host}/${gateway.address}`, `local=/*.${rule.host}/`],
    ),
];

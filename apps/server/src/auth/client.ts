import { Option, Result } from "effect";
import type { HttpServerRequest } from "effect/http";
import { IpNetwork, NetAddress } from "effect/net";

/** Parses a bare, bracketed, or `ip:port` address, as `HttpMiddleware.xForwardedHeaders` does. */
const parseAddress = (input: string): Option.Option<NetAddress.IpAddress> => {
  const address = NetAddress.ipFromString(
    input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input,
  );
  if (Result.isSuccess(address)) return Option.some(NetAddress.toCanonical(address.success));
  const inet = NetAddress.inetAddressFromString(input);
  return Result.isSuccess(inet)
    ? Option.some(NetAddress.toCanonical(inet.success.address))
    : Option.none();
};

/**
 * Why `clientAddress` used the connection address instead of `X-Forwarded-For`.
 *
 * - `no-connection-address`: the socket has no address.
 * - `untrusted-peer`: the socket peer isn't in `auth.trusted_proxies`.
 * - `no-forwarded-header`: a trusted peer sent no `X-Forwarded-For` header.
 * - `unreadable-forwarded-entry`: a trusted peer's header holds an entry that isn't an IP address.
 */
type ConnectionReason =
  | "no-connection-address"
  | "untrusted-peer"
  | "no-forwarded-header"
  | "unreadable-forwarded-entry";

/** The address that sign-in rate limits count a request against, and where it comes from. */
export type ClientAddress =
  | { readonly address: string; readonly source: "forwarded" }
  | {
      readonly address: string;
      readonly source: "connection";
      readonly reason: ConnectionReason;
      /** The ignored `X-Forwarded-For` header, or `undefined` when the request has none. */
      readonly forwardedFor: string | undefined;
    };

/**
 * Returns the address that sign-in rate limits count a request against.
 *
 * When the socket peer belongs to `trustedProxies`, `X-Forwarded-For` is read from the right and
 * trusted proxies are skipped, so the result is the address that the outermost trusted proxy
 * received the request from. Otherwise, and when the header is missing or holds an entry that isn't
 * an IP address, the result is the socket peer address. The address is `unknown` when the socket
 * has no address.
 */
export const clientAddress = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
): ClientAddress => {
  const trusted = (address: NetAddress.IpAddress) =>
    trustedProxies.some((network) => IpNetwork.contains(network, address));
  const forwardedFor = request.headers["x-forwarded-for"];
  const connection = (address: string, reason: ConnectionReason): ClientAddress => ({
    address,
    source: "connection",
    reason,
    forwardedFor,
  });
  const peer = Option.flatMap(request.peerAddress, parseAddress);
  if (Option.isNone(peer)) return connection("unknown", "no-connection-address");
  const peerAddress = NetAddress.formatIp(peer.value);
  if (!trusted(peer.value)) return connection(peerAddress, "untrusted-peer");
  if (forwardedFor === undefined) return connection(peerAddress, "no-forwarded-header");
  const entries = forwardedFor.split(",").map((entry) => entry.trim());
  for (let index = entries.length - 1; index >= 0; index--) {
    const address = parseAddress(entries[index] ?? "");
    if (Option.isNone(address)) break;
    if (index > 0 && trusted(address.value)) continue;
    return { address: NetAddress.formatIp(address.value), source: "forwarded" };
  }
  return connection(peerAddress, "unreadable-forwarded-entry");
};

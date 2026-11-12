import { Option, Result } from "effect";
import type { HttpServerRequest } from "effect/http";
import { IpNetwork, NetAddress } from "effect/net";

const parseAddress = (input: string): Option.Option<NetAddress.IpAddress> => {
  const address = NetAddress.ipFromString(
    input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input,
  );
  return Result.isSuccess(address)
    ? Option.some(NetAddress.toCanonical(address.success))
    : Option.none();
};

/**
 * Returns the address that sign-in rate limits count a request against.
 *
 * When the socket peer belongs to `trustedProxies`, `X-Forwarded-For` is read from the right and
 * trusted proxies are skipped, so the result is the address that the outermost trusted proxy
 * received the request from. Otherwise, and when the header is missing or holds an entry that isn't
 * an IP address, the result is the socket peer address. Returns `unknown` when the socket has no
 * address.
 */
export const clientAddress = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
): string => {
  const trusted = (address: NetAddress.IpAddress) =>
    trustedProxies.some((network) => IpNetwork.contains(network, address));
  const peer = Option.flatMap(request.peerAddress, parseAddress);
  if (Option.isNone(peer)) return "unknown";
  const forwarded = request.headers["x-forwarded-for"];
  if (!trusted(peer.value) || forwarded === undefined) return NetAddress.formatIp(peer.value);
  const entries = forwarded.split(",").map((entry) => entry.trim());
  for (let index = entries.length - 1; index >= 0; index--) {
    const address = parseAddress(entries[index] ?? "");
    if (Option.isNone(address)) break;
    if (index > 0 && trusted(address.value)) continue;
    return NetAddress.formatIp(address.value);
  }
  return NetAddress.formatIp(peer.value);
};

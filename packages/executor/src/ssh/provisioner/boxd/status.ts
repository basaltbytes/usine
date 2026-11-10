import { Code, ConnectError } from "@connectrpc/connect";

const codeName = (code: Code): string =>
  (Code[code] ?? "Unknown")
    .replace(/[A-Z]/gu, (letter, index) => `${index === 0 ? "" : "_"}${letter}`)
    .toUpperCase();

/**
 * Returns the gRPC status name of `failure`, such as `NOT_FOUND`. A connection that the client
 * cancelled, reset, or couldn't route counts as `UNAVAILABLE`.
 */
export const failureCode = (failure: ConnectError): string => {
  if (!failure.isWireError && failure.code === Code.Canceled) return "UNAVAILABLE";
  const cause = failure.cause;
  return cause instanceof Error &&
    "code" in cause &&
    ["ECONNRESET", "ECONNABORTED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(
      String(cause.code),
    )
    ? "UNAVAILABLE"
    : codeName(failure.code);
};

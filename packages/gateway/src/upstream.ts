import { Schema } from "effect";

/** The base URL of an upstream API: scheme, host, and an optional path prefix, with no query, fragment, or trailing slash. */
export const UpstreamBase = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*[^/?#\s])?$/u, {
    message: "Expected an http(s) base URL without a query or a trailing slash",
  }),
).pipe(Schema.brand("UpstreamBase"));
export type UpstreamBase = typeof UpstreamBase.Type;

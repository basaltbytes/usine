import { Effect, Option } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** Connection-level headers that are never forwarded (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
] as const;

/** Returns `headers` without hop-by-hop headers, including those listed in `Connection`. */
export const endToEndHeaders = (headers: Headers.Headers): Headers.Headers => {
  const listed = Option.match(Headers.get(headers, "connection"), {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (value) => value.split(",").map((name) => name.trim().toLowerCase()),
  });
  return [...HOP_BY_HOP, ...listed].reduce(
    (remaining, name) => Headers.remove(remaining, name),
    headers,
  );
};

const hasBody = (request: HttpServerRequest.HttpServerRequest): boolean =>
  Option.isSome(Headers.get(request.headers, "transfer-encoding")) ||
  Option.match(Headers.get(request.headers, "content-length"), {
    onNone: () => false,
    onSome: (length) => length.trim() !== "0",
  });

/**
 * Sends `request` to `upstream` with `headers` and streams the response back unchanged:
 * status, end-to-end headers, and body bytes, including any `content-encoding`. Bodies stream
 * in both directions without buffering. The client span is disabled, so no header value is
 * recorded in a trace.
 */
export const forwardRequest = (
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  upstream: string,
  headers: Headers.Headers,
) => {
  const base = HttpClientRequest.make(request.method)(upstream);
  const outgoing = (
    hasBody(request) ? HttpClientRequest.bodyStream(base, request.stream) : base
  ).pipe(HttpClientRequest.setHeaders(headers));
  return client.execute(outgoing).pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.map((response) =>
      HttpServerResponse.stream(response.stream, {
        status: response.status,
        headers: endToEndHeaders(response.headers),
      }),
    ),
  );
};

import type { MachineProvider } from "@usine/core/worker";
import { Data, Effect, Option, type Redacted, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

/** The timeout for one provider API request. */
const REQUEST_TIMEOUT = "30 seconds";

/** A provider API request that got no response or an unreadable one. */
export class ProviderUnanswered extends Data.TaggedError("ProviderUnanswered")<{
  readonly detail: string;
}> {}

/** A provider API response with an error status, with the provider's error code and message. */
class ProviderRefused extends Data.TaggedError("ProviderRefused")<{
  readonly status: number;
  readonly code: Option.Option<string>;
  readonly message: string;
}> {}

export type ProviderFailure = ProviderUnanswered | ProviderRefused;

/** A decoded provider API response. */
export interface ProviderResponse {
  readonly status: number;
  /** The JSON body, or `null` if the response has none. */
  readonly body: Schema.Json;
}

/** The code and message of an error response body. */
interface ProviderError {
  readonly code: Option.Option<string>;
  readonly message: string;
}

const ErrorFields = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

/** Hetzner's error body, `{ error: { code, message } }`. */
const NestedErrorBody = Schema.Struct({ error: ErrorFields });

const decodeNestedError = Schema.decodeUnknownOption(NestedErrorBody);
const decodeFlatError = Schema.decodeUnknownOption(ErrorFields);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/** Returns the code and message of Hetzner's or Boat's error body (Boat's are top-level). */
const errorOf = (response: ProviderResponse): ProviderError => {
  const fields = Option.orElse(
    Option.map(decodeNestedError(response.body), ({ error }) => error),
    () => decodeFlatError(response.body),
  );
  return {
    code: Option.flatMap(fields, ({ code }) => Option.fromNullishOr(code)),
    message: Option.getOrElse(
      Option.flatMap(fields, ({ message }) => Option.fromNullishOr(message)),
      () => "no message",
    ),
  };
};

/**
 * Returns a client for a provider's JSON API at `base` with `token` as its bearer token. Each
 * request has a timeout, and an error status fails with the provider's code and message. The
 * token and request body never appear in a failure.
 */
export const providerApiFor = (
  provider: MachineProvider,
  base: string,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const send = Effect.fn("ProviderApi.send")(function* (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      options: {
        readonly body?: unknown;
        readonly headers?: Readonly<Record<string, string>>;
        readonly query?: Readonly<Record<string, string>>;
      } = {},
    ) {
      yield* Effect.annotateCurrentSpan({ provider, method, path });
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(options.query ?? {}))
        url.searchParams.set(key, value);
      const request = HttpClientRequest.make(method)(url).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(options.headers ?? {}),
        options.body === undefined
          ? (unchanged) => unchanged
          : HttpClientRequest.bodyJsonUnsafe(options.body),
      );
      const response = yield* http.execute(request).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((cause) =>
          HttpClientError.isHttpClientError(cause)
            ? new ProviderUnanswered({ detail: `no response (${cause.reason._tag})` })
            : new ProviderUnanswered({ detail: `no response within ${REQUEST_TIMEOUT}` }),
        ),
      );
      const text = yield* response.text.pipe(
        Effect.mapError(
          () => new ProviderUnanswered({ detail: "the response body can't be read" }),
        ),
      );
      const body =
        text === ""
          ? null
          : yield* decodeJson(text).pipe(
              Effect.mapError(
                () =>
                  new ProviderUnanswered({
                    detail: `the response with status ${String(response.status)} isn't JSON`,
                  }),
              ),
            );
      const answer: ProviderResponse = { status: response.status, body };
      if (response.status >= 400) {
        const { code, message } = errorOf(answer);
        return yield* new ProviderRefused({ status: response.status, code, message });
      }
      return answer;
    });

    /** Decodes a response body with `schema`; an unexpected shape counts as unanswered. */
    const decode =
      <S extends Schema.Constraint>(schema: S, operation: string) =>
      (
        response: ProviderResponse,
      ): Effect.Effect<S["Type"], ProviderUnanswered, S["DecodingServices"]> =>
        Schema.decodeUnknownEffect(schema)(response.body).pipe(
          Effect.mapError(
            () =>
              new ProviderUnanswered({
                detail: `the response to ${operation} doesn't have the documented shape`,
              }),
          ),
        );

    return { send, decode } as const;
  });

/** Returns a failure as an operator-facing clause. */
export const failureText = (failure: ProviderFailure): string =>
  failure._tag === "ProviderUnanswered"
    ? failure.detail
    : `status ${String(failure.status)}${Option.match(failure.code, {
        onNone: () => "",
        onSome: (code) => ` ${code}`,
      })}: ${failure.message}`;

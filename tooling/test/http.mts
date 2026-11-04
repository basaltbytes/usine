import { Effect, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** Returns the native response so HTTP integration tests can assert headers and consume bodies. */
export const webRequest = (input: string | URL | Request, init?: RequestInit) =>
  HttpClient.execute(HttpClientRequest.fromWeb(new Request(input, init))).pipe(
    Effect.flatMap((response) =>
      Option.match(HttpClientResponse.toWeb(response), {
        onSome: Effect.succeed,
        onNone: () => Effect.die(new Error("FetchHttpClient returned no native response")),
      }),
    ),
    Effect.provideService(FetchHttpClient.RequestInit, init ?? {}),
  );

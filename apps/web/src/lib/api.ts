import { csrfToken } from "./auth";
import { OperatorApi } from "@usine/orchestrator/operator/http";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/**
 * A representation that a read names in `X-Usine-View`. Without one, the overview, a project,
 * and a task are summaries.
 */
type View = "shell" | "board" | "task" | "attention" | "full";

const makeClient = (view?: View) =>
  HttpApiClient.make(OperatorApi, {
    baseUrl: globalThis.location.origin,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.setHeaders(
            request,
            view === undefined
              ? { "x-usine-csrf": csrfToken() }
              : { "x-usine-csrf": csrfToken(), "x-usine-view": view },
          ),
        ),
        HttpClient.tap((response) =>
          Effect.sync(() => {
            if (response.status === 401) window.location.replace("/sign-in");
          }),
        ),
      ),
  });

type Client = Effect.Success<ReturnType<typeof makeClient>>;

const run = <A, E>(request: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(
    request.pipe(
      // No exporter sees the browser's spans, so a trace header would give each request span a
      // parent that no collector has.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  );

/** Runs an operator API request and returns a Promise that rejects with the decoded API error. */
export const api = <A, E>(
  request: (client: Client["operator"]) => Effect.Effect<A, E>,
  view?: View,
): Promise<A> => run(Effect.flatMap(makeClient(view), (client) => request(client.operator)));

/** Runs a request of the operator API's conversation group, as `api` does. */
export const conversationApi = <A, E>(
  request: (client: Client["conversation"]) => Effect.Effect<A, E>,
): Promise<A> => run(Effect.flatMap(makeClient(), (client) => request(client.conversation)));

/** Returns the message of the value an `api` request rejected with. */
export const rejectionMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

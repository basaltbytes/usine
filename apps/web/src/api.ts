import { OperatorApi } from "@usine/orchestrator/operator/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const makeClient = () => HttpApiClient.make(OperatorApi, { baseUrl: globalThis.location.origin });

/** Runs an operator API request and returns a Promise that rejects with the decoded API error. */
export const api = <A, E>(
  request: (
    client: Effect.Success<ReturnType<typeof makeClient>>["operator"],
  ) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(makeClient(), (client) => request(client.operator)).pipe(
      Effect.provide(FetchHttpClient.layer),
    ),
  );

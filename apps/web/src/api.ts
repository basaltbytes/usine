import { OperatorApi } from "@usine/orchestrator/operator/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const makeClient = () => HttpApiClient.make(OperatorApi, { baseUrl: globalThis.location.origin });

/** Runs a typed operator request as a Promise for TanStack Query, preserving decoded failures. */
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

import { Duration, Effect, Option, Schedule, Schema } from "effect";
import { GitHubApiError, InvalidGitHubResponseError } from "./error.ts";

export class GraphqlServerError extends Schema.TaggedError<GraphqlServerError>(
  "@usine/github/GraphqlServerError",
)("GraphqlServerError", { failure: InvalidGitHubResponseError }) {}

export const isTransientStatus = (status: number): boolean =>
  status === 502 || status === 503 || status === 504;

export const retryTransientRequest = <A, E, R>(request: Effect.Effect<A, E, R>) =>
  request.pipe(
    Effect.retry(($) =>
      $(Schedule.exponential("1 second", 3)).pipe(
        Schedule.jittered,
        Schedule.while(({ input: error }) =>
          Effect.succeed(
            error instanceof GraphqlServerError ||
              (error instanceof GitHubApiError && Option.exists(error.status, isTransientStatus)),
          ),
        ),
        Schedule.upTo({ times: 2 }),
        Schedule.tap(({ input: error, attempt, duration }) => {
          if (error instanceof GraphqlServerError || error instanceof GitHubApiError) {
            const failure = error instanceof GraphqlServerError ? error.failure : error;
            return Effect.logWarning("Transient GitHub request failed; retrying", {
              operation: failure.operation,
              status:
                error instanceof GraphqlServerError ? 200 : Option.getOrUndefined(error.status),
              errorTag: error._tag,
              retry: attempt,
              delayMs: Duration.toMillis(duration),
            });
          }
          return Effect.void;
        }),
      ),
    ),
  );

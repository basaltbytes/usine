import type { RepositoryName } from "@usine/core/repository";
import { GitHubApp } from "@usine/github/github-app";
import { GitHubPolling } from "@usine/github/polling";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { Effect, Option } from "effect";

const unavailable = () =>
  new OperatorHttpError({
    error: "BackendUnavailableError",
    message: "GitHub configuration choices are unavailable. Check the GitHub App credentials.",
  });

export const configurationRepositories = Effect.fn("Http.configurationRepositories")(function* () {
  const app = yield* Effect.serviceOption(GitHubApp);
  if (Option.isNone(app)) {
    yield* Effect.logInfo("Installation repository lookup unavailable in setup mode");
    return yield* unavailable();
  }
  // The UI removes registered repositories using the current configuration query.
  return yield* app.value.repositories().pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Installation repository lookup failed", { errorTag: error._tag }),
    ),
    Effect.mapError(() => unavailable()),
  );
});

export const configurationLabels = Effect.fn("Http.configurationLabels")(function* (
  repository: RepositoryName,
) {
  yield* Effect.annotateCurrentSpan({ repository });
  const polling = yield* Effect.serviceOption(GitHubPolling);
  if (Option.isNone(polling)) {
    yield* Effect.logInfo("Repository label lookup unavailable in setup mode", { repository });
    return yield* unavailable();
  }
  const result = yield* polling.value.labels(repository, Option.none()).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Repository label lookup failed", { repository, errorTag: error._tag }),
    ),
    Effect.mapError(() => unavailable()),
  );
  if (!("labels" in result)) {
    yield* Effect.logWarning("GitHub returned no label catalog for an unconditional request", {
      repository,
    });
    return yield* unavailable();
  }
  yield* Effect.logDebug("Loaded repository label choices", {
    repository,
    count: result.labels.length,
  });
  return result.labels;
});

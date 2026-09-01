import { Item, Repository } from "@usine/core";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "./github-app.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";
import type { GitHubAppError } from "./model.ts";

const LabelResponse = Schema.Array(Schema.Struct({ name: Schema.NonEmptyString }));

const labelsUrl = (repository: Repository.Name, item: number): string => {
  const { name, owner } = Repository.parts(repository);
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${item}/labels`;
};

/** Authenticated GitHub Item writes used by the Board trigger surface. */
export class GitHubItemWriter extends Context.Service<
  GitHubItemWriter,
  {
    /** Replaces the Item's applied labels without deleting repository label definitions. */
    readonly setLabels: (
      repository: Repository.Name,
      item: Item.Number,
      labels: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, GitHubAppError>;
  }
>()("@usine/github/GitHubItemWriter") {
  static readonly layer: Layer.Layer<GitHubItemWriter, never, GitHubApp | HttpClient.HttpClient> =
    Layer.effect(
      GitHubItemWriter,
      Effect.gen(function* () {
        const app = yield* GitHubApp;
        const http = yield* HttpClient.HttpClient;

        return {
          setLabels: Effect.fn("GitHubItemWriter.setLabels")(function* (
            repository: Repository.Name,
            item: Item.Number,
            labels: ReadonlyArray<string>,
          ) {
            yield* Effect.annotateCurrentSpan({ repository, item });
            const token = yield* app.installationToken();
            const request = HttpClientRequest.put(labelsUrl(repository, item)).pipe(
              HttpClientRequest.bodyJsonUnsafe({ labels }),
              authorized(token.value),
            );
            const response = yield* http
              .execute(request)
              .pipe(Effect.mapError((error) => transportError("set-item-labels", error)));
            if (response.status < 200 || response.status >= 300) {
              return yield* statusError(
                "set-item-labels",
                response,
                yield* Clock.currentTimeMillis,
              );
            }
            const applied = yield* HttpClientResponse.schemaBodyJson(LabelResponse)(response).pipe(
              Effect.mapError((error) => invalidResponse("set-item-labels", error.message)),
            );
            yield* Effect.logInfo("GitHub Item labels replaced from a Board move", {
              repository,
              item,
              labels: applied.map(({ name }) => name).join(", "),
            });
            return applied.map(({ name }) => name);
          }),
        };
      }),
    );
}

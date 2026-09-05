import { RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { ItemNumber } from "@usine/core/item";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "./github-app.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";
import type { GitHubAppError } from "./model.ts";

const LabelResponse = Schema.Array(Schema.Struct({ name: Schema.NonEmptyString }));
const LabelNames = Schema.Array(Schema.NonEmptyString).check(Schema.isUnique());

/** Lane-scoped label changes. Labels outside these two sets are never rewritten. */
export class ItemLabelMutation extends Schema.Class<ItemLabelMutation>(
  "@usine/github/ItemLabelMutation",
)({
  add: LabelNames.check(Schema.isNonEmpty()),
  remove: LabelNames,
}) {}

const labelsUrl = (repository: RepositoryName, item: number): string => {
  const { name, owner } = splitRepositoryName(repository);
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${item}/labels`;
};

const labelUrl = (repository: RepositoryName, item: number, label: string): string =>
  `${labelsUrl(repository, item)}/${encodeURIComponent(label)}`;

/** Authenticated GitHub Item writes used by the Board trigger surface. */
export class GitHubItemWriter extends Context.Service<
  GitHubItemWriter,
  {
    /** Adds/removes only the named labels; every other applied label is preserved. */
    readonly updateLabels: (
      repository: RepositoryName,
      item: ItemNumber,
      mutation: ItemLabelMutation,
    ) => Effect.Effect<ReadonlyArray<string>, GitHubAppError>;
  }
>()("@usine/github/GitHubItemWriter") {
  static readonly layer: Layer.Layer<GitHubItemWriter, never, GitHubApp | HttpClient.HttpClient> =
    Layer.effect(
      GitHubItemWriter,
      Effect.gen(function* () {
        const app = yield* GitHubApp;
        const http = yield* HttpClient.HttpClient;

        const send = Effect.fn("GitHubItemWriter.sendLabelUpdate")(function* (
          request: HttpClientRequest.HttpClientRequest,
        ) {
          return yield* http
            .execute(request)
            .pipe(Effect.mapError((error) => transportError("update-item-labels", error)));
        });

        const decode = (response: HttpClientResponse.HttpClientResponse) =>
          HttpClientResponse.schemaBodyJson(LabelResponse)(response).pipe(
            Effect.mapError((error) => invalidResponse("update-item-labels", error.message)),
          );

        return {
          updateLabels: Effect.fn("GitHubItemWriter.updateLabels")(function* (
            repository: RepositoryName,
            item: ItemNumber,
            mutation: ItemLabelMutation,
          ) {
            yield* Effect.annotateCurrentSpan({ repository, item });
            const token = yield* app.installationToken();
            const addResponse = yield* send(
              HttpClientRequest.post(labelsUrl(repository, item)).pipe(
                HttpClientRequest.bodyJsonUnsafe({ labels: mutation.add }),
                authorized(token.value),
              ),
            );
            if (addResponse.status < 200 || addResponse.status >= 300) {
              return yield* statusError(
                "update-item-labels",
                addResponse,
                yield* Clock.currentTimeMillis,
              );
            }
            let applied = yield* decode(addResponse);
            for (const label of mutation.remove) {
              const removeResponse = yield* send(
                HttpClientRequest.delete(labelUrl(repository, item, label)).pipe(
                  authorized(token.value),
                ),
              );
              if (removeResponse.status === 404) {
                yield* Effect.logDebug("Lane label was already absent during Board move", {
                  repository,
                  item,
                  label,
                });
                continue;
              }
              if (removeResponse.status < 200 || removeResponse.status >= 300) {
                return yield* statusError(
                  "update-item-labels",
                  removeResponse,
                  yield* Clock.currentTimeMillis,
                );
              }
              applied = yield* decode(removeResponse);
            }
            yield* Effect.logInfo("GitHub Item lane labels updated from a Board move", {
              repository,
              item,
              addedLabels: mutation.add.join(", "),
              removedLabels: mutation.remove.join(", "),
              labels: applied.map(({ name }) => name).join(", "),
            });
            return applied.map(({ name }) => name);
          }),
        };
      }),
    );
}

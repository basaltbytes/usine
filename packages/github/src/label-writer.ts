import { RepositoryName } from "@usine/core/ids";
import { splitRepositoryName } from "@usine/core/repository";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GitHubApp } from "./github-app.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "./http.ts";
import type { GitHubAppError } from "./model.ts";
import { RepositoryLabel, RepositoryLabelColor, RepositoryLabelName } from "./polling/model.ts";

/** One repository-label definition accepted by GitHub's create endpoint. */
export class NewRepositoryLabel extends Schema.Class<NewRepositoryLabel>(
  "@usine/github/NewRepositoryLabel",
)({
  name: RepositoryLabelName,
  color: Schema.Option(RepositoryLabelColor),
  description: Schema.Option(Schema.String),
}) {}

const CreateLabelResponse = Schema.Struct({
  name: RepositoryLabelName,
  color: RepositoryLabelColor,
  description: Schema.NullOr(Schema.String),
});

interface CreateLabelBody {
  readonly name: RepositoryLabelName;
  color?: RepositoryLabelColor;
  description?: string;
}

const labelsUrl = (repository: RepositoryName): string => {
  const { name, owner } = splitRepositoryName(repository);
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/labels`;
};

/** Authenticated repository-label creation under the App installation token. */
export class GitHubLabelWriter extends Context.Service<
  GitHubLabelWriter,
  {
    readonly create: (
      repository: RepositoryName,
      label: NewRepositoryLabel,
    ) => Effect.Effect<RepositoryLabel, GitHubAppError>;
  }
>()("@usine/github/GitHubLabelWriter") {
  static readonly layer: Layer.Layer<GitHubLabelWriter, never, GitHubApp | HttpClient.HttpClient> =
    Layer.effect(
      GitHubLabelWriter,
      Effect.gen(function* () {
        const app = yield* GitHubApp;
        const http = yield* HttpClient.HttpClient;

        return {
          create: Effect.fn("GitHubLabelWriter.create")(function* (
            repository: RepositoryName,
            label: NewRepositoryLabel,
          ) {
            yield* Effect.annotateCurrentSpan({ repository, label: label.name });
            const token = yield* app.installationToken();
            const body: CreateLabelBody = { name: label.name };
            if (Option.isSome(label.color)) body.color = label.color.value;
            if (Option.isSome(label.description)) body.description = label.description.value;
            const request = HttpClientRequest.post(labelsUrl(repository)).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
              authorized(token.value),
            );
            const response = yield* http
              .execute(request)
              .pipe(Effect.mapError((error) => transportError("create-repository-label", error)));
            if (response.status < 200 || response.status >= 300) {
              return yield* statusError(
                "create-repository-label",
                response,
                yield* Clock.currentTimeMillis,
              );
            }
            const created = yield* HttpClientResponse.schemaBodyJson(CreateLabelResponse)(
              response,
            ).pipe(
              Effect.mapError((error) => invalidResponse("create-repository-label", error.message)),
            );
            return new RepositoryLabel({
              name: created.name,
              color: created.color,
              description: Option.fromNullishOr(created.description),
            });
          }),
        };
      }),
    );
}

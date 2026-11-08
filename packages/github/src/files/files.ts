import { jsonKey } from "@usine/core/json-key";
import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import { Cache, Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubApp } from "../github-app.ts";
import type { GitHubAppError } from "../error.ts";
import { API_ROOT, authorized, invalidResponse, statusError, transportError } from "../http.ts";
import { retryTransientRequest } from "../retry.ts";
import {
  changedFile,
  PullRequestFilesChangedError,
  type ChangedFile,
  FileChanges,
  FileRead,
  GitHubFile,
  type FileChangesQuery,
} from "./model.ts";

export {
  ChangedFile,
  FileChanges,
  FileChangesQuery,
  PullRequestFilesQuery,
  CommitRangeFilesQuery,
  PullRequestFilesChangedError,
} from "./model.ts";

const MAX_CACHED_RESPONSE_BYTES = 512 * 1024;
const encoder = new TextEncoder();

const PullRequest = Schema.Struct({
  head: Schema.Struct({ sha: CommitSha }),
  base: Schema.Struct({ sha: CommitSha }),
  changed_files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const Comparison = Schema.Struct({
  files: Schema.Array(GitHubFile),
});

/** Reads commit-pinned patches with installation authentication and a shared immutable cache. */
export class GitHubFiles extends Context.Service<
  GitHubFiles,
  {
    readonly read: (
      repository: RepositoryName,
      item: ItemNumber,
      selection: FileChangesQuery,
    ) => Effect.Effect<FileChanges, GitHubAppError | PullRequestFilesChangedError>;
  }
>()("@usine/github/files/files/GitHubFiles") {
  static readonly layer = Layer.effect(
    GitHubFiles,
    Effect.gen(function* () {
      const app = yield* GitHubApp;
      const http = yield* HttpClient.HttpClient;
      const get = Effect.fn("GitHubFiles.get")(function* <S extends Schema.Top>(
        path: string,
        schema: S,
      ) {
        const token = yield* app.installationToken;
        const response = yield* http
          .execute(HttpClientRequest.get(`${API_ROOT}/${path}`).pipe(authorized(token.value)))
          .pipe(Effect.mapError((error) => transportError("read-pull-request-files", error)));
        if (response.status !== 200) {
          const now = yield* Clock.currentTimeMillis;
          return yield* statusError("read-pull-request-files", response, now);
        }
        return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError((error) => invalidResponse("read-pull-request-files", error.message)),
        );
      }, retryTransientRequest);

      const load = Effect.fn("GitHubFiles.load")(function* ({
        repository,
        item,
        selection,
      }: FileRead) {
        yield* Effect.annotateCurrentSpan({
          repository,
          item,
          base: selection.base,
          head: selection.head,
          scope: selection._tag,
        });
        const prefix = `repos/${repository}`;
        if (selection._tag !== "PullRequestFiles") {
          const base = selection.base;
          const comparison = yield* get(
            `${prefix}/compare/${base}...${selection.head}?per_page=1`,
            Comparison,
          );
          const changes = FileChanges.make({
            base,
            head: selection.head,
            files: comparison.files.map(changedFile),
            // GitHub provides at most 300 files and no total, so the limit is conservative.
            filesTruncated: comparison.files.length >= 300,
          });
          yield* Effect.logDebug("Read commit comparison files", {
            repository,
            base,
            head: selection.head,
            files: changes.files.length,
            filesTruncated: changes.filesTruncated,
          });
          return changes;
        }
        const path = `${prefix}/pulls/${item}`;
        const before = yield* get(path, PullRequest);
        if (before.head.sha !== selection.head || before.base.sha !== selection.base)
          return yield* PullRequestFilesChangedError.make({
            message:
              "The pull request base or head changed. Refresh the task to load the latest changes.",
          });
        const files: Array<ChangedFile> = [];
        let page = 1;
        while (files.length < before.changed_files && page <= 30) {
          const entries = yield* get(
            `${path}/files?per_page=100&page=${page}`,
            Schema.Array(GitHubFile),
          );
          files.push(...entries.map(changedFile));
          if (entries.length < 100) break;
          page += 1;
        }
        const after = yield* get(path, PullRequest);
        if (
          after.head.sha !== before.head.sha ||
          after.base.sha !== before.base.sha ||
          after.changed_files !== before.changed_files
        )
          return yield* PullRequestFilesChangedError.make({
            message:
              "The pull request changed while loading files. Refresh the task and retry to load a consistent diff.",
          });
        const changes = FileChanges.make({
          base: before.base.sha,
          head: selection.head,
          files,
          filesTruncated: files.length < before.changed_files,
        });
        yield* Effect.logDebug("Read pull request files", {
          repository,
          item,
          head: selection.head,
          files: files.length,
          filesTruncated: changes.filesTruncated,
        });
        return changes;
      });
      const cache = yield* Cache.makeWith(load, {
        capacity: 128,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) &&
          encoder.encode(jsonKey(exit.value)).byteLength <= MAX_CACHED_RESPONSE_BYTES
            ? Infinity
            : 0,
      });
      return {
        read: Effect.fn("GitHubFiles.read")(function* (
          repository: RepositoryName,
          item: ItemNumber,
          selection: FileChangesQuery,
        ) {
          yield* Effect.annotateCurrentSpan({
            repository,
            item,
            base: selection.base,
            head: selection.head,
          });
          return yield* Cache.get(
            cache,
            FileRead.make({
              repository: RepositoryName.make(canonicalRepositoryName(repository)),
              item,
              selection,
            }),
          );
        }),
      };
    }),
  );
}

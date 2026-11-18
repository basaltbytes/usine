import { ItemNumber } from "@usine/core/item";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import {
  CommitRangeFilesQuery,
  FileChanges,
  PullRequestFilesQuery,
} from "@usine/github/file-changes";
import { Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";

const offset = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/** A whole-PR or attempt file selection, and the offset of the first file of the page to read. */
const PagedFileChangesQuery = Schema.Union([
  Schema.Struct({ ...PullRequestFilesQuery.fields, offset }).pipe(
    Schema.encodeKeys({ _tag: "scope" }),
  ),
  Schema.Struct({ ...CommitRangeFilesQuery.fields, offset }).pipe(
    Schema.encodeKeys({ _tag: "scope" }),
  ),
]);

export const pullRequestFilesRead = HttpApiEndpoint.get(
  "pullRequestFiles",
  "/api/projects/:project/pull-requests/:repository/:item/files",
  {
    params: Schema.Struct({ project: ProjectId, repository: RepositoryName, item: ItemNumber }),
    query: PagedFileChangesQuery,
    success: FileChanges,
  },
)
  .annotate(OpenApi.Summary, "Read pull request or attempt changes")
  .annotate(
    OpenApi.Description,
    "Returns commit-pinned files for a whole pull request or a comparison from an attempt checkout base to its pushed head, from `offset`: the files and patches that fit 20 KB of JSON, with `total` and the `nextOffset` of the next page, which is null after the last file. A patch that alone doesn't fit the page is cut and marked truncated; read the file in the repository instead. Reports missing patches and truncated file lists. `X-Usine-View: full` returns every file with its whole patch. Requires read access to the repository's project.",
  )
  .annotate(OpenApi.Transform, (operation) => ({
    ...operation,
    parameters: [
      ...operation.parameters,
      ...[
        {
          name: "scope",
          schema: Schema.Union([
            PullRequestFilesQuery.fields._tag,
            CommitRangeFilesQuery.fields._tag,
          ]),
          required: true,
          description: "Select the whole PR or a commit range.",
        },
        {
          name: "head",
          schema: PullRequestFilesQuery.fields.head,
          required: true,
          description: "The full pushed head commit SHA.",
        },
        {
          name: "base",
          schema: CommitRangeFilesQuery.fields.base,
          required: true,
          description: "The full PR base commit SHA or attempt checkout base commit SHA.",
        },
        {
          name: "offset",
          schema: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          required: false,
          description:
            "The position of the first file to return, as `nextOffset` gives it. Defaults to 0.",
        },
      ].map(({ name, schema, required, description }) => ({
        name,
        in: "query",
        required,
        description,
        schema: Schema.toJsonSchemaDocument(schema).schema,
      })),
    ],
  }));

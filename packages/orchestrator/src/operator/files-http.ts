import { ItemNumber } from "@usine/core/item";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import {
  CommitRangeFilesQuery,
  FileChanges,
  FileChangesQuery,
  PullRequestFilesQuery,
} from "@usine/github/files";
import { Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";

export const pullRequestFilesRead = HttpApiEndpoint.get(
  "pullRequestFiles",
  "/api/projects/:project/pull-requests/:repository/:item/files",
  {
    params: Schema.Struct({ project: ProjectId, repository: RepositoryName, item: ItemNumber }),
    query: FileChangesQuery,
    success: FileChanges,
  },
)
  .annotate(OpenApi.Summary, "Read pull request or attempt changes")
  .annotate(
    OpenApi.Description,
    "Returns commit-pinned files for a whole pull request or a comparison from an attempt checkout base to its pushed head. Reports missing patches and truncated file lists. Requires read access to the repository's project.",
  )
  .annotate(OpenApi.Transform, (operation) => ({
    ...operation,
    parameters: [
      ...operation.parameters,
      ...[
        {
          name: "_tag",
          schema: Schema.Union(FileChangesQuery.members.map((member) => member.fields._tag)),
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
      ].map(({ name, schema, required, description }) => ({
        name,
        in: "query",
        required,
        description,
        schema: Schema.toJsonSchemaDocument(schema).schema,
      })),
    ],
  }));

import { ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { type Brand, Schema } from "effect";

export class PullRequestFilesQuery extends Schema.TaggedClass<
  PullRequestFilesQuery,
  Brand.Brand<"@usine/github/files/PullRequestFilesQuery">
>("PullRequestFilesQuery")("PullRequestFiles", { base: CommitSha, head: CommitSha }) {}

export class CommitRangeFilesQuery extends Schema.TaggedClass<
  CommitRangeFilesQuery,
  Brand.Brand<"@usine/github/files/CommitRangeFilesQuery">
>("CommitRangeFilesQuery")("CommitRangeFiles", { base: CommitSha, head: CommitSha }) {}

export const FileChangesQuery = Schema.Union([PullRequestFilesQuery, CommitRangeFilesQuery]);
export type FileChangesQuery = typeof FileChangesQuery.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A GitHub file patch; omitted patches can be binary or too large for GitHub. */
const FilePatch = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String, truncated: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("omitted") }),
]);

export class ChangedFile extends Schema.Class<
  ChangedFile,
  Brand.Brand<"@usine/github/files/ChangedFile">
>("ChangedFile")({
  path: Schema.NonEmptyString,
  oldPath: Schema.NullOr(Schema.NonEmptyString),
  status: Schema.Literals(["added", "modified", "removed", "renamed"]),
  additions: Count,
  deletions: Count,
  patch: FilePatch,
  test: Schema.Boolean,
  generated: Schema.Boolean,
}) {}

/** Immutable files for the returned commit range, with GitHub's file-list limit reported. */
export class FileChanges extends Schema.Class<
  FileChanges,
  Brand.Brand<"@usine/github/files/FileChanges">
>("FileChanges")({
  base: CommitSha,
  head: CommitSha,
  files: Schema.Array(ChangedFile),
  filesTruncated: Schema.Boolean,
}) {}

export class FileRead extends Schema.Class<FileRead, Brand.Brand<"@usine/github/files/FileRead">>(
  "FileRead",
)({
  repository: RepositoryName,
  item: ItemNumber,
  selection: FileChangesQuery,
}) {}

export const GitHubFile = Schema.Struct({
  filename: Schema.NonEmptyString,
  previous_filename: Schema.optionalKey(Schema.NonEmptyString),
  status: Schema.Literals([
    "added",
    "modified",
    "removed",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  additions: Count,
  deletions: Count,
  patch: Schema.optionalKey(Schema.String),
});

export const changedFile = (file: typeof GitHubFile.Type): ChangedFile => {
  const lines = file.patch?.split("\n") ?? [];
  const additions = lines.filter((line) => line.startsWith("+")).length;
  const deletions = lines.filter((line) => line.startsWith("-")).length;
  return ChangedFile.make({
    path: file.filename,
    oldPath: file.previous_filename ?? null,
    status:
      file.status === "copied" || file.status === "changed" || file.status === "unchanged"
        ? "modified"
        : file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch:
      file.patch === undefined
        ? { kind: "omitted" }
        : {
            kind: "text",
            text: file.patch,
            truncated: additions !== file.additions || deletions !== file.deletions,
          },
    test: /(?:^|\/)(?:tests?|__tests__|__snapshots__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/iu.test(
      file.filename,
    ),
    generated:
      /(?:^|\/)(?:generated|dist|vendor)(?:\/|$)|(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(?:gen|generated|min)\.[^/]+$|\.snap$/iu.test(
        file.filename,
      ),
  });
};

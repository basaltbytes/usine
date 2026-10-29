import { Schema } from "effect";

/** A GitHub `owner/name` in the casing from config; compare with `canonicalRepositoryName`. */
export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    message: "Expected a full GitHub repo name (owner/name)",
  }),
).pipe(Schema.brand("RepositoryName"));

export type RepositoryName = typeof RepositoryName.Type;

/** The branch, tag, commit, or `HEAD` to check out for an Attempt, resolved when the Attempt is prepared. */
export const RepositoryRevision = Schema.String.check(
  Schema.isPattern(/^[^\s-]\S*$/u, {
    message: "Expected a Git revision without whitespace or a leading dash",
  }),
).pipe(Schema.brand("RepositoryRevision"));
export type RepositoryRevision = typeof RepositoryRevision.Type;

/** A full SHA-1 or SHA-256 commit ID in lowercase hex. */
export const CommitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u, {
    message: "Expected a 40- or 64-character lowercase Git object ID",
  }),
).pipe(Schema.brand("CommitSha"));
export type CommitSha = typeof CommitSha.Type;

/** Returns `value` with every character outside `[A-Za-z0-9_.-]` replaced by `_`, for a path or ref segment. */
export const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

/** Returns the owner and repository portions of `repository`, preserving their configured casing. */
export const splitRepositoryName = (repository: RepositoryName) => {
  const separator = repository.indexOf("/");
  return {
    /** The GitHub user or organization that owns the repository, in configured casing. */
    owner: repository.slice(0, separator),
    /** The repository name without its owner, in configured casing. */
    name: repository.slice(separator + 1),
  } as const;
};

/** Returns the comparison key for a repository name; GitHub names are case-insensitive. */
export const canonicalRepositoryName = (repository: RepositoryName): string =>
  repository.toLowerCase();

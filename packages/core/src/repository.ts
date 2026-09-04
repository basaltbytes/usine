import { Schema } from "effect";

/**
 * Full `owner/name` of a GitHub repository, in the casing the operator wrote.
 * Compare through `canonicalRepositoryName`, since GitHub ignores case.
 */
export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    message: "Expected a full GitHub repo name (owner/name)",
  }),
).pipe(Schema.brand("RepositoryName"));

export type RepositoryName = typeof RepositoryName.Type;

/** A git revision safe to pass to `git fetch` as a bare argument: no whitespace and no leading dash. */
export const RepositoryRevision = Schema.String.check(
  Schema.isPattern(/^[^\s-]\S*$/u, {
    message: "Expected a git revision without whitespace or a leading dash",
  }),
).pipe(Schema.brand("RepositoryRevision"));
export type RepositoryRevision = typeof RepositoryRevision.Type;

/** A 40- or 64-character lowercase git object id. */
export const CommitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u, {
    message: "Expected a 40- or 64-character lowercase git object id",
  }),
).pipe(Schema.brand("CommitSha"));
export type CommitSha = typeof CommitSha.Type;

/** Splits a repository name into its `owner` and `name`. */
export const splitRepositoryName = (repository: RepositoryName) => {
  const separator = repository.indexOf("/");
  return {
    owner: repository.slice(0, separator),
    name: repository.slice(separator + 1),
  } as const;
};

/** Lowercases a repository name for comparison, since GitHub ignores case. */
export const canonicalRepositoryName = (repository: RepositoryName): string =>
  repository.toLowerCase();

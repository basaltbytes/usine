import { Schema } from "effect";

/**
 * Value object: the stable `owner/name` identity shared by the registry and
 * every GitHub-facing block. The original casing is significant to display;
 * GitHub comparisons are handled separately at the adapter boundary.
 */
export const Name = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    message: "Expected a full GitHub repo name (owner/name)",
  }),
).pipe(Schema.brand("RepoName"));
export type Name = typeof Name.Type;

/** Value object: a git revision resolved when an Attempt workspace is created. */
export const Revision = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank git revision" }),
).pipe(Schema.brand("RepositoryRevision"));
export type Revision = typeof Revision.Type;

/** Value object: a git object id harvested from an Attempt workspace. */
export const CommitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u, {
    message: "Expected a 40- or 64-character lowercase git object id",
  }),
).pipe(Schema.brand("CommitSha"));
export type CommitSha = typeof CommitSha.Type;

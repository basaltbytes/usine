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

/** The `owner` and `name` halves of a full repo name; the brand proves the separator exists. */
export const parts = (repository: Name) => {
  const separator = repository.indexOf("/");
  return {
    owner: repository.slice(0, separator),
    name: repository.slice(separator + 1),
  } as const;
};

/** Case-insensitive comparison key: GitHub repo names differ only by display casing. */
export const canonical = (repository: Name): string => repository.toLowerCase();

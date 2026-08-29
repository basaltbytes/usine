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

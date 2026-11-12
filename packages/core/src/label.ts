import { Schema } from "effect";

/**
 * A trimmed label name of at most 50 characters, as GitHub stores it. Any other name never
 * matches the GitHub label and is re-created every cycle.
 */
export const GitHubLabelName = Schema.String.check(
  Schema.isPattern(/^\S(?:.*\S)?$/u, {
    message: "Expected a GitHub label name without surrounding whitespace",
  }),
  Schema.isMaxLength(50, { message: "Expected a GitHub label name of at most 50 characters" }),
).pipe(Schema.brand("GitHubLabelName"));

export type GitHubLabelName = typeof GitHubLabelName.Type;

/** Returns the comparison key for a label name; GitHub compares label names case-insensitively. */
export const canonicalLabelName = (name: string): string => name.toLowerCase();

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

/** A label color as six hex digits without a leading `#`, as GitHub stores it. */
export const GitHubLabelColor = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{6}$/u, {
    message: "Expected a six-digit hex GitHub label color without #",
  }),
).pipe(Schema.brand("GitHubLabelColor"));

export type GitHubLabelColor = typeof GitHubLabelColor.Type;

const GitHubLabelDescription = Schema.String.check(
  Schema.isMaxLength(100, {
    message: "Expected a GitHub label description of at most 100 characters",
  }),
);

/** A label created in every managed repository. */
export class DeclaredLabel extends Schema.Class<DeclaredLabel>("@usine/config/DeclaredLabel")({
  name: GitHubLabelName,
  color: Schema.OptionFromOptionalKey(GitHubLabelColor),
  description: Schema.OptionFromOptionalKey(GitHubLabelDescription),
}) {}

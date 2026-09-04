import { Schema } from "effect";

/**
 * GitHub trims label names and caps them at 50 characters. A name outside that
 * contract never matches the catalog and would be re-created every cycle.
 */
export const GitHubLabelName = Schema.String.check(
  Schema.isPattern(/^\S(?:.*\S)?$/u, {
    message: "Expected a GitHub label name without surrounding whitespace",
  }),
  Schema.isMaxLength(50, { message: "Expected a GitHub label name of at most 50 characters" }),
).pipe(Schema.brand("GitHubLabelName"));

export type GitHubLabelName = typeof GitHubLabelName.Type;

/** Compare label names on this key: GitHub matches them case-insensitively. */
export const canonicalLabelName = (name: string): string => name.toLowerCase();

/** Six hex digits without a leading hash, as GitHub stores label colors. */
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

/** A label the factory creates in every managed repository. */
export class DeclaredLabel extends Schema.Class<DeclaredLabel>("@usine/config/DeclaredLabel")({
  name: GitHubLabelName,
  color: Schema.OptionFromOptionalKey(GitHubLabelColor),
  description: Schema.OptionFromOptionalKey(GitHubLabelDescription),
}) {}

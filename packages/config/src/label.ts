import { Schema } from "effect";

/**
 * GitHub trims label names and caps them at 50 characters; a name outside that
 * contract would never match the catalog and would be re-created every cycle.
 */
export const GitHubLabelName = Schema.String.check(
  Schema.isPattern(/^\S(?:.*\S)?$/u, {
    message: "Expected a GitHub label name without surrounding whitespace",
  }),
  Schema.isMaxLength(50, { message: "Expected a GitHub label name of at most 50 characters" }),
).pipe(Schema.brand("GitHubLabelName"));

export type GitHubLabelName = typeof GitHubLabelName.Type;

/** GitHub matches label names case-insensitively; compare declarations on this key. */
export const canonicalLabelName = (name: string): string => name.toLowerCase();

/** GitHub label colors are authored as six hex digits without a leading hash. */
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

/** One factory-wide label declaration, provisioned into every managed repository. */
export class DeclaredLabel extends Schema.Class<DeclaredLabel>("@usine/config/DeclaredLabel")({
  name: GitHubLabelName,
  color: Schema.OptionFromOptionalKey(GitHubLabelColor),
  description: Schema.OptionFromOptionalKey(GitHubLabelDescription),
}) {}

import { GitHubLabelName } from "@usine/core/label";
import { type Brand, Schema } from "effect";

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
export class DeclaredLabel extends Schema.Class<
  DeclaredLabel,
  Brand.Brand<"@usine/config/label/DeclaredLabel">
>("@usine/config/DeclaredLabel")({
  /** The GitHub label name, compared case-insensitively. */
  name: GitHubLabelName,
  /** Six hex digits without `#`, or `None` to let GitHub choose the color. */
  color: Schema.OptionFromOptionalKey(GitHubLabelColor),
  /** The label description, at most 100 characters, or `None` to omit it on creation. */
  description: Schema.OptionFromOptionalKey(GitHubLabelDescription),
}) {}

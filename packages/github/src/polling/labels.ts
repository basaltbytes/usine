import { Schema } from "effect";
import { EntityTag } from "./detection.ts";

/** A repository label name as returned by GitHub, preserved without case conversion. */
export const RepositoryLabelName = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubRepositoryLabelName"),
);
export type RepositoryLabelName = typeof RepositoryLabelName.Type;

/** GitHub stores label colors as six hex digits without the leading hash. */
export const RepositoryLabelColor = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{6}$/u, { message: "Expected a six-digit hex label color" }),
).pipe(Schema.brand("GitHubRepositoryLabelColor"));
export type RepositoryLabelColor = typeof RepositoryLabelColor.Type;

/** One repository label as GitHub defines it. The name routes lanes, and color and description are presentation only. */
export class RepositoryLabel extends Schema.Class<RepositoryLabel>("@usine/github/RepositoryLabel")(
  {
    name: RepositoryLabelName,
    color: RepositoryLabelColor,
    description: Schema.OptionFromNullOr(Schema.String),
  },
) {}

const uniqueLabelNames = Schema.makeFilter<ReadonlyArray<RepositoryLabel>>(
  (labels) => new Set(labels.map(({ name }) => name)).size === labels.length,
  { message: "Expected unique label names" },
);

/** A complete label catalog with the ETag of its canonical REST URL. */
export class RepositoryLabelCatalog extends Schema.Class<RepositoryLabelCatalog>(
  "@usine/github/RepositoryLabelCatalog",
)({
  entityTag: Schema.OptionFromNullOr(EntityTag),
  labels: Schema.Array(RepositoryLabel).check(uniqueLabelNames),
}) {}

/** GitHub confirmed the catalog named by its ETag has not changed. */
export class RepositoryLabelsNotModified extends Schema.TaggedClass<RepositoryLabelsNotModified>(
  "@usine/github/RepositoryLabelsNotModified",
)("RepositoryLabelsNotModified", {}) {}

/** A complete label catalog or confirmation that the cached catalog is unchanged. */
export const RepositoryLabelDetection = Schema.Union([
  RepositoryLabelCatalog,
  RepositoryLabelsNotModified,
]);
export type RepositoryLabelDetection = typeof RepositoryLabelDetection.Type;

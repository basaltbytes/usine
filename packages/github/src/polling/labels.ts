import { Schema } from "effect";
import { EntityTag } from "./detection.ts";

/** A repository label name as returned by GitHub, with case preserved. */
export const RepositoryLabelName = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubRepositoryLabelName"),
);
export type RepositoryLabelName = typeof RepositoryLabelName.Type;

/** A label color as six hex digits without the leading `#`. */
export const RepositoryLabelColor = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{6}$/u, { message: "Expected a six-digit hex label color" }),
).pipe(Schema.brand("GitHubRepositoryLabelColor"));
export type RepositoryLabelColor = typeof RepositoryLabelColor.Type;

/** A repository label. The name selects lanes; color and description are for display only. */
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

/** The result when GitHub confirms that the catalog with this ETag hasn't changed. */
export class RepositoryLabelsNotModified extends Schema.TaggedClass<RepositoryLabelsNotModified>(
  "@usine/github/RepositoryLabelsNotModified",
)("RepositoryLabelsNotModified", {}) {}

/** A complete label catalog, or confirmation that the cached catalog is unchanged. */
export const RepositoryLabelDetection = Schema.Union([
  RepositoryLabelCatalog,
  RepositoryLabelsNotModified,
]);
export type RepositoryLabelDetection = typeof RepositoryLabelDetection.Type;

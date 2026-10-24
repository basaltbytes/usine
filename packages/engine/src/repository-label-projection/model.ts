import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const RepositoryLabelName = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank repository label" }),
);

/** A label color as six hex digits, absent in older catalogs. */
export const RepositoryLabelColor = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{6}$/u, { message: "Expected a six-digit hex label color" }),
);

export class RepositoryLabel extends Schema.Class<RepositoryLabel>("@usine/engine/RepositoryLabel")(
  {
    name: RepositoryLabelName,
    color: Schema.OptionFromNullOr(RepositoryLabelColor),
    description: Schema.OptionFromNullOr(Schema.String),
  },
) {}

const uniqueLabelNames = Schema.makeFilter<ReadonlyArray<RepositoryLabel>>(
  (labels) => new Set(labels.map(({ name }) => name)).size === labels.length,
  { message: "Expected unique label names" },
);
const RepositoryLabels = Schema.Array(RepositoryLabel).check(uniqueLabelNames);

/** The latest complete label catalog that polling observed for a repository. */
export class RepositoryLabelProjection extends Schema.Class<RepositoryLabelProjection>(
  "@usine/engine/RepositoryLabelProjection",
)({
  repository: RepositoryName,
  labels: RepositoryLabels,
}) {}

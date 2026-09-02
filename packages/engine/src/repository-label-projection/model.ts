import { Repository } from "@usine/core";
import { Schema } from "effect";

const RepositoryLabelName = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank repository label" }),
);

/** Six hex digits, as GitHub stores label colors; absent for catalogs stored before colors were kept. */
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

/** Latest complete repository label catalog observed by trigger polling. */
export class RepositoryLabelProjection extends Schema.Class<RepositoryLabelProjection>(
  "@usine/engine/RepositoryLabelProjection",
)({
  repository: Repository.Name,
  labels: RepositoryLabels,
}) {}

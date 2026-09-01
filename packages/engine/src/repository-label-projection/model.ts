import { Repository } from "@usine/core";
import { Schema } from "effect";

const RepositoryLabel = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank repository label" }),
);
const RepositoryLabels = Schema.Array(RepositoryLabel).check(Schema.isUnique());

/** Latest complete repository label catalog observed by trigger polling. */
export class RepositoryLabelProjection extends Schema.Class<RepositoryLabelProjection>(
  "@usine/engine/RepositoryLabelProjection",
)({
  repository: Repository.Name,
  labels: RepositoryLabels,
}) {}

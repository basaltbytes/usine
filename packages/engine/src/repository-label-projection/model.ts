import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";

const RepositoryLabelName = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank repository label" }),
);

/** A label color as six hex digits, absent in older catalogs. */
export const RepositoryLabelColor = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{6}$/u, { message: "Expected a six-digit hex label color" }),
);

/** A label in a managed repo, with optional GitHub color and description metadata. */
export class RepositoryLabel extends Schema.Class<RepositoryLabel>("@usine/engine/RepositoryLabel")(
  {
    /** The nonblank GitHub label name, preserved with its original case. */
    name: RepositoryLabelName,
    /** Six hexadecimal RGB digits without `#`, or `None` for catalogs that stored only names. */
    color: Schema.OptionFromNullOr(RepositoryLabelColor),
    /** The GitHub label description, or `None` when absent or unavailable in an older catalog. */
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
  /** The managed repo whose complete label catalog was observed. */
  repository: RepositoryName,
  /** The complete catalog with unique names; an empty array records a repo without labels. */
  labels: RepositoryLabels,
}) {}

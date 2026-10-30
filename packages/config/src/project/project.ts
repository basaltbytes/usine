import { ProjectId } from "@usine/core/project";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import { Effect, Schema } from "effect";
import { LaneSource, Lane } from "../board.ts";
import { canonicalLabelName } from "../label.ts";
import { nonBlankString, uniqueRepositoryNames } from "../checks.ts";

const laneSourceKey = (source: LaneSource): string =>
  "label" in source ? `label:${canonicalLabelName(source.label)}` : `state:${source.state}`;

const uniqueLaneSources = Schema.makeFilter<ReadonlyArray<Lane>>(
  (lanes) => {
    const keys = lanes.flatMap(({ sources }) => sources.map(laneSourceKey));
    return new Set(keys).size === keys.length;
  },
  { message: "Expected each lane source in only one lane" },
);

export const Lanes = Schema.Array(Lane).check(
  Schema.makeFilter((lanes) => new Set(lanes.map(({ name }) => name)).size === lanes.length, {
    message: "Expected unique lane names",
  }),
  uniqueLaneSources,
);

/**
 * A named group of registered repositories with shared lanes and project-scoped loops (ADR 0031).
 */
export class Project extends Schema.Class<Project>("@usine/config/Project")({
  /** The slug used to qualify loop names and project export paths. */
  id: ProjectId,
  /** The nonblank project display name. */
  name: nonBlankString("Expected a project display name"),
  /** Ordered, nonempty registry names, unique under case-insensitive comparison. */
  repositories: Schema.NonEmptyArray(RepositoryName).check(
    uniqueRepositoryNames((name: RepositoryName) => name),
  ),
  /** The ordered lane map with unique names and sources; an empty map allows proposed lanes. */
  lanes: Lanes.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
}) {
  /** Returns whether `repository` is a member, comparing repository names case-insensitively. */
  includes(repository: RepositoryName): boolean {
    return this.repositories.some(
      (name) => canonicalRepositoryName(name) === canonicalRepositoryName(repository),
    );
  }
}

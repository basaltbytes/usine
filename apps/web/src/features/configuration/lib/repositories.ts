import type { LabelStateView, RepositoryConfigurationView } from "@usine/orchestrator/operator";

export const laneLabels = (
  repository: RepositoryConfigurationView,
): ReadonlyArray<LabelStateView> =>
  repository.lanes.flatMap(({ sources }) =>
    sources.flatMap((source) => (source._tag === "Label" ? [source.label] : [])),
  );

export interface LabelStanding {
  readonly text: string;
  readonly problem: boolean;
}

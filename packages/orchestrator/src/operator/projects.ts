import type { UsineConfig } from "@usine/config/factory";
import { BoardView, ReadOnlyBoardLaneView, WritableBoardLaneView } from "./board.ts";
import { ProjectView } from "./overview.ts";

export const groupProjectViews = (
  config: UsineConfig,
  views: ReadonlyArray<ProjectView>,
): ReadonlyArray<ProjectView> => {
  if (config.version === 1) return views;
  return config.projects.map((project) => {
    const members = views.filter(({ repository }) => project.includes(repository));
    const lanes = new Map<string, ReadOnlyBoardLaneView | WritableBoardLaneView>();
    for (const member of members) {
      for (const lane of member.board.lanes) {
        const previous = lanes.get(lane.id);
        const items = [...(previous?.items ?? []), ...lane.items];
        lanes.set(
          lane.id,
          lane._tag === "WritableBoardLane"
            ? new WritableBoardLaneView({ ...lane, items })
            : new ReadOnlyBoardLaneView({ ...lane, items }),
        );
      }
    }
    return new ProjectView({
      id: project.id,
      name: project.name,
      repositories: project.repositories,
      repository: project.repositories[0],
      status: "clear",
      runs: members.flatMap(({ runs }) => runs),
      board: new BoardView({
        lanes: [...lanes.values()],
        failures: members.flatMap(({ board }) => board.failures),
      }),
      labels: [
        ...new Map(
          members.flatMap(({ labels }) => labels).map((label) => [label.name, label]),
        ).values(),
      ],
      preflightFindings: members.flatMap(({ preflightFindings }) => preflightFindings),
    });
  });
};

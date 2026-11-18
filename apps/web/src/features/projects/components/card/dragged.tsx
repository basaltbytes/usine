import type { ProjectId } from "@usine/core/project";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { CardFace } from "~/features/projects/components/card/face";
import { CardFrame } from "~/features/projects/components/card/frame";
import { type LabelCatalog } from "~/lib/projects/card";

type DraggedCardProps = {
  readonly project?: ProjectId | undefined;
  readonly showRepository?: boolean | undefined;
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly stall: StalledItemView | null;
};

export const DraggedCard = ({
  item,
  lane,
  catalog,
  stall,
  project,
  showRepository,
}: DraggedCardProps) => (
  <CardFrame needsYou={item.needsYou} className="cursor-grabbing shadow-raised">
    <CardFace
      project={project}
      showRepository={showRepository}
      item={item}
      lane={lane}
      catalog={catalog}

      stall={stall}
      readOnly
      action={null}
      again={null}
      progress={null}
    />
  </CardFrame>
);

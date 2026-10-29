import type { ProjectId } from "@usine/core/project";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { Card } from "~/components/ui/card";
import { cardClass } from "~/features/projects/lib/styles";
import { CardFace } from "~/features/projects/components/card/face";
import { type LabelCatalog } from "~/lib/projects/card";
import { cn } from "~/lib/utils";

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
  <Card size="sm" className={cn(cardClass(item.needsYou), "cursor-grabbing shadow-raised")}>
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
  </Card>
);

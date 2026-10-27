import type { RepositoryName } from "@usine/core/repository";
import type { BoardLaneView, BoardTaskView, StalledItemView } from "@usine/orchestrator/operator";
import { Card } from "~/components/ui/card";
import { cardClass } from "~/features/projects/lib/styles";
import { CardFace } from "~/features/projects/components/card/face";
import { type LabelCatalog } from "~/lib/projects/card";
import { cn } from "~/lib/utils";

type DraggedCardProps = {
  readonly item: BoardTaskView;
  readonly lane: BoardLaneView;
  readonly catalog: LabelCatalog;
  readonly repository: RepositoryName;
  readonly stall: StalledItemView | null;
};

export const DraggedCard = ({ item, lane, catalog, repository, stall }: DraggedCardProps) => (
  <Card size="sm" className={cn(cardClass(item.needsYou), "cursor-grabbing shadow-raised")}>
    <CardFace
      item={item}
      lane={lane}
      catalog={catalog}
      repository={repository}
      stall={stall}
      readOnly
      action={null}
      again={null}
      progress={null}
    />
  </Card>
);

import type { LaneSourceView } from "@usine/orchestrator/operator";
import { LabelBadge } from "~/components/label-badge";
import { Badge } from "~/components/ui/badge";
import { LabelStanding } from "~/features/configuration/components/repositories/label-standing";

type SourceChipProps = { readonly source: LaneSourceView };

export const SourceChip = ({ source }: SourceChipProps) =>
  source._tag === "Label" ? (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <LabelBadge name={source.label.name} label={source.label} />
      <span className="text-xs">
        <LabelStanding label={source.label} />
      </span>
    </span>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      {source.state}
    </Badge>
  );

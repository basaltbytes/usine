import { LabelBadge } from "~/components/label-badge";
import { Badge } from "~/components/ui/badge";
import { type LabelCatalog } from "~/lib/projects/card";

const VISIBLE_LABELS = 3;

type CardLabelsProps = {
  readonly labels: ReadonlyArray<string>;
  readonly catalog: LabelCatalog;
};

export const CardLabels = ({ labels, catalog }: CardLabelsProps) => {
  if (labels.length === 0) return null;
  const hidden = labels.slice(VISIBLE_LABELS);
  return (
    <div className="flex flex-wrap gap-1">
      {labels.slice(0, VISIBLE_LABELS).map((label) => (
        <LabelBadge key={label} name={label} label={catalog.get(label)} />
      ))}
      {hidden.length > 0 && (
        <Badge
          variant="outline"
          className="text-muted-foreground tabular-nums"
          title={hidden.join(", ")}
          aria-label={`${hidden.length} more: ${hidden.join(", ")}`}
        >
          +{hidden.length}
        </Badge>
      )}
    </div>
  );
};

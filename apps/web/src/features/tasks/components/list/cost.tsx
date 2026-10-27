import type { TaskUsageView } from "@usine/orchestrator/operator";
import { LowerBoundMark } from "~/features/tasks/components/list/lower-bound-mark";
import { PoolHover } from "~/features/tasks/components/list/pool-hover";
import { usdLabel } from "~/lib/strings";
import { costUnpriced, unpricedNote } from "~/lib/tasks/model";

type TaskCostProps = { readonly usage: TaskUsageView };

/** Renders the Task's cost in dollars, marked `*` if some usage is not priced yet, or nothing if no
 * usage is priced. */
export const TaskCost = ({ usage }: TaskCostProps) => {
  if (usage.cost === null) return null;
  const unpriced = costUnpriced(usage);
  const usd = usdLabel(usage.cost.usd);
  return (
    <PoolHover
      usage={usage}
      label={`Estimated cost: ${unpriced ? "at least " : ""}${usd}. Show per pool`}
      note={unpriced ? unpricedNote : null}
    >
      {usd}
      {unpriced && <LowerBoundMark />}
    </PoolHover>
  );
};

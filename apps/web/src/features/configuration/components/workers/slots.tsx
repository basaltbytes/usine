import type { WorkerSlotsView } from "@usine/orchestrator/operator";
import { cn } from "~/lib/utils";

type SlotCellsProps = { readonly slots: WorkerSlotsView };

/** Renders one cell per slot on one line, filled while an Attempt uses it. If a reload lowers
 * `max_concurrent_attempts`, Attempts still running above the limit add filled cells. */
export const SlotCells = ({ slots }: SlotCellsProps) => (
  <span aria-hidden="true" className="inline-flex gap-1">
    {Array.from({ length: Math.max(slots.capacity, slots.leased) }, (_, index) => (
      <span
        key={index}
        className={cn(
          "size-2.5 rounded-xs ring-1 ring-inset",
          index < slots.leased ? "bg-run-active ring-run-active" : "ring-input",
        )}
      />
    ))}
  </span>
);

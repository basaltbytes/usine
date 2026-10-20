import type { WorkerView } from "@usine/orchestrator/operator";
import { StateMark } from "@/components/status-badge";
import { agoLabel, timestampLabel } from "../operator-copy.ts";

const Preflight = ({ worker, now }: { readonly worker: WorkerView; readonly now: number }) => {
  const preflight = worker.preflight;
  if (preflight === null) return <span>No preflight yet</span>;
  const passed = preflight._tag === "Passed";
  return (
    <span
      className={passed ? undefined : "text-destructive"}
      title={passed ? timestampLabel(preflight.checkedAt) : preflight.message}
    >
      <StateMark state={passed ? "Succeeded" : "Failed"} className="mr-1.5 align-middle" />
      Preflight {passed ? "passed" : "failed"} {agoLabel(preflight.checkedAt, now)}
    </span>
  );
};

/** Each Worker on one line: its name, slots in use of its total, and its last preflight. */
export const WorkersLine = ({
  workers,
  now,
}: {
  readonly workers: ReadonlyArray<WorkerView>;
  readonly now: number;
}) => (
  <footer
    aria-label="Workers"
    className="flex flex-wrap items-baseline gap-x-8 gap-y-1.5 border-t pt-3 text-xs text-muted-foreground"
  >
    <span className="font-medium text-foreground">Workers</span>
    {workers.map((worker) => (
      <span key={worker.name} className="inline-flex flex-wrap items-baseline gap-x-3">
        <span className="font-mono text-foreground">{worker.name}</span>
        <span className="tabular-nums">
          {worker.slots.leased} of {worker.slots.capacity}{" "}
          {worker.slots.capacity === 1 ? "slot" : "slots"} in use
        </span>
        <Preflight worker={worker} now={now} />
      </span>
    ))}
  </footer>
);

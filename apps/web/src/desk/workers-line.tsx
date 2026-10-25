import type { ProvisioningPauseView, WorkerView } from "@usine/orchestrator/operator";
import { StateMark } from "@/components/status-badge";
import {
  agoLabel,
  creationFailureTitle,
  nextCreationLine,
  timestampLabel,
} from "../operator-copy.ts";

const outcome = {
  Passed: { state: "Succeeded", label: "passed", className: undefined },
  Degraded: { state: "Waiting", label: "degraded", className: "text-run-waiting" },
  Deferred: { state: "Deferred", label: "deferred", className: undefined },
  Failed: { state: "Failed", label: "failed", className: "text-destructive" },
} as const;

const Preflight = ({ worker, now }: { readonly worker: WorkerView; readonly now: number }) => {
  const preflight = worker.preflight;
  if (preflight === null) return <span>No preflight yet</span>;
  const { state, label, className } = outcome[preflight._tag];
  return (
    <span
      className={className}
      title={preflight._tag === "Passed" ? timestampLabel(preflight.checkedAt) : preflight.message}
    >
      <StateMark state={state} className="mr-1.5 align-middle" />
      Preflight {label} {agoLabel(preflight.checkedAt, now)}
    </span>
  );
};

const CreationPaused = ({
  pause,
  now,
}: {
  readonly pause: ProvisioningPauseView;
  readonly now: number;
}) => (
  <span className="text-destructive" title={pause.message}>
    <StateMark state="Failed" className="mr-1.5 align-middle" />
    {creationFailureTitle(pause)}.{" "}
    <span className="tabular-nums">{nextCreationLine(pause, now)}</span>
  </span>
);

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
          {worker.machines.length > 0 &&
            `, ${worker.machines.length} ${worker.machines.length === 1 ? "machine" : "machines"}`}
        </span>
        <Preflight worker={worker} now={now} />
        {worker.provisioning?.blocked === true && (
          <CreationPaused pause={worker.provisioning} now={now} />
        )}
      </span>
    ))}
  </footer>
);

import { upgradeWaitLine } from "~/lib/runs/strings";
import type { ProvisioningPauseView, WorkerView } from "@usine/orchestrator/operator";
import { StateMark } from "~/components/status-badge";
import { agoLabel, timestampLabel } from "~/lib/strings";
import { creationFailureTitle, nextCreationLine } from "~/lib/workers/strings";

const outcome = {
  Passed: { state: "Succeeded", label: "passed", className: undefined },
  Degraded: { state: "Waiting", label: "degraded", className: "text-run-waiting" },
  Deferred: { state: "Deferred", label: "deferred", className: undefined },
  Failed: { state: "Failed", label: "failed", className: "text-destructive" },
} as const;

type PreflightProps = { readonly worker: WorkerView; readonly now: number };

const Preflight = ({ worker, now }: PreflightProps) => {
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

type CreationPausedProps = {
  readonly pause: ProvisioningPauseView;
  readonly now: number;
};

const CreationPaused = ({ pause, now }: CreationPausedProps) => (
  <span className="text-destructive" title={pause.message}>
    <StateMark state="Failed" className="mr-1.5 align-middle" />
    {creationFailureTitle(pause)}.{" "}
    <span className="tabular-nums">{nextCreationLine(pause, now)}</span>
  </span>
);

type WorkersLineProps = {
  readonly workers: ReadonlyArray<WorkerView>;
  readonly now: number;
};

export const WorkersLine = ({ workers, now }: WorkersLineProps) => (
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
        {worker.upgradeWait !== null && <span>{upgradeWaitLine(worker.upgradeWait)}</span>}
        <Preflight worker={worker} now={now} />
        {worker.provisioning?.blocked === true && (
          <CreationPaused pause={worker.provisioning} now={now} />
        )}
      </span>
    ))}
  </footer>
);

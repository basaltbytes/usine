import { Link } from "@tanstack/react-router";
import type { MachineView } from "@usine/orchestrator/operator";
import { Unset } from "~/features/configuration/components/section";

type MachineForProps = { readonly machine: MachineView };

/** Renders the Run a machine serves, which opens its drawer, or its Attempt after a restart. */
export const MachineFor = ({ machine }: MachineForProps) => {
  const { runId, attemptId } = machine;
  if (runId !== null)
    return (
      <Link
        to="."
        search={(previous) => ({ ...previous, run: runId })}
        className="text-primary hover:underline"
      >
        Run <span className="font-mono text-xs">{runId.slice(0, 8)}</span>
      </Link>
    );
  if (attemptId === null) return <Unset>Found after a restart</Unset>;
  return (
    <span>
      Attempt <span className="font-mono text-xs">{attemptId.slice(0, 8)}</span>
      <Unset>, found after a restart</Unset>
    </span>
  );
};

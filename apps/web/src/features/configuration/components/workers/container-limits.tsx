import type { ContainerView, WorkerConfigurationView } from "@usine/orchestrator/operator";
import { Unset } from "~/features/configuration/components/section";
import { containerLimitsLabel, containerLimitSources } from "~/features/configuration/strings";

type ContainerLimitsProps = {
  readonly container: ContainerView;
  readonly applied: WorkerConfigurationView["containerLimits"];
};

/**
 * Renders the limits of each Attempt container: the ones the last preflight of the machine
 * applied, else the ones `usine.yaml` sets, and which ones preflight derives from the machine.
 */
export const ContainerLimits = ({ container, applied }: ContainerLimitsProps) => {
  const { configured, derived } = containerLimitSources(container);
  const shown = applied === null ? configured : containerLimitsLabel(applied);
  const note =
    applied === null
      ? "Derived from the machine at preflight"
      : "Derived from the machine at the last preflight";
  return (
    <span className="flex flex-col gap-1">
      {shown !== null && <span className="tabular-nums">{shown}</span>}
      {derived !== null && <Unset>{`${note}: ${derived}`}</Unset>}
    </span>
  );
};

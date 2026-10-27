import type { MachineProvider } from "@usine/core/worker";
import type { MachineView, ProvisioningPauseView } from "@usine/orchestrator/operator";
import { agoLabel, dayTimeLabel, timestampLabel } from "~/lib/strings";

export const providerLabel = {
  hetzner: "Hetzner",
  boat: "Boat",
} as const satisfies Record<MachineProvider, string>;

/** The provider's word for one machine, as in `Hetzner server 52341896`. */
export const providerMachineNoun = {
  hetzner: "server",
  boat: "sandbox",
} as const satisfies Record<MachineProvider, string>;

/** Returns the status of a machine being created, such as `Creating a Hetzner machine, started 2m ago`. */
export const machineCreationLine = (machine: MachineView, now: number): string =>
  `Creating a ${providerLabel[machine.provider]} machine, started ${agoLabel(machine.since, now)}`;

const creationFailureReason = {
  capacity: "no capacity",
  quota: "quota reached",
  refused: "refused by the provider",
  provider: "provider error",
  unreachable: "unreachable",
  timeout: "SSH timeout",
} as const satisfies Record<Exclude<ProvisioningPauseView["reason"], "check">, string>;

/** Returns why a provisioned Worker has no new machine, such as `Machine creation failed: quota reached`. */
export const creationFailureTitle = ({ reason }: ProvisioningPauseView): string =>
  reason === "check"
    ? "Preflight failed on the first machine of the day"
    : `Machine creation failed: ${creationFailureReason[reason]}`;

/** Returns `instant` to the minute, with its day unless it is on the day of `now`: `19:46` or `26 Oct 07:46`. */
const nearTimeLabel = (instant: string, now: number): string =>
  new Date(instant).toDateString() === new Date(now).toDateString()
    ? timestampLabel(instant).slice(11)
    : dayTimeLabel(instant);

/** Returns when a provisioned Worker creates a machine again: `Next try at 19:46`, or `Pause ended at 19:46`. */
export const nextCreationLine = (
  { blocked, retryAt }: ProvisioningPauseView,
  now: number,
): string => `${blocked ? "Next try" : "Pause ended"} at ${nearTimeLabel(retryAt, now)}`;

/** Returns how often machine creation failed, for example `Failed 3 times in a row, last at 19:31`. */
export const creationFailuresLine = ({ failures, failedAt }: ProvisioningPauseView, now: number) =>
  `${failures === 1 ? "Failed once" : `Failed ${failures} times in a row`}, last at ${nearTimeLabel(failedAt, now)}`;

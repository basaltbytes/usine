import type { SshWorker } from "@usine/config/factory";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import {
  BoatSize,
  HetznerImage,
  HetznerLocation,
  HetznerResourceName,
  HetznerServerType,
  MachineId,
  MachineProvider,
  SshUser,
  WorkerName,
} from "@usine/core/worker";
import { MachineState, type MachineStatus, MachineUnavailableReason } from "@usine/executor";
import { DateTime, Effect, Option, Schema } from "effect";
import type { ProvisioningPause } from "../worker-status.ts";

/** A machine that a provisioned Worker created for one Attempt and hasn't deleted yet. */
export class MachineView extends Schema.Class<MachineView>("@usine/orchestrator/MachineView")({
  worker: WorkerName,
  provider: MachineProvider,
  state: MachineState,
  /** The provider's ID, or null until the provider accepts the creation. */
  id: Schema.NullOr(MachineId),
  /** The Run it was created for, or null for a machine found after a restart. */
  runId: Schema.NullOr(RunId),
  /** The Attempt it serves, or null until the Attempt starts. */
  attemptId: Schema.NullOr(AttemptId),
  /** When its creation started, or when the provider created a machine found after a restart, as an ISO instant. */
  since: Schema.String,
}) {}

export class WorkerQuotaView extends Schema.Class<WorkerQuotaView>(
  "@usine/orchestrator/WorkerQuotaView",
)({
  worker: WorkerName,
  provider: MachineProvider,
  message: Schema.NonEmptyString,
  recovery: Schema.NonEmptyString,
}) {}

/** Runs with a machine being created or ready for an attempt. */
export const runsWithMachines = (machines: ReadonlyArray<MachineStatus>): ReadonlySet<RunId> =>
  new Set(
    machines.flatMap((machine) =>
      machine.state === "deleting" ? [] : Option.toArray(machine.runId),
    ),
  );

export const workerQuotas = (
  pauses: ReadonlyArray<ProvisioningPause>,
): ReadonlyArray<WorkerQuotaView> =>
  pauses.flatMap(({ worker, quota }) =>
    Option.toArray(
      Option.map(
        quota,
        ({ provider, message }) =>
          new WorkerQuotaView({
            worker,
            provider,
            message,
            recovery:
              provider === "hetzner"
                ? "Request a limit increase in the Hetzner console, choose a smaller server_type, or delete unused servers to free capacity."
                : "Raise the plan or usage limit in the Boat console, add funds for more time, choose a smaller size, or stop unused sandboxes to free capacity.",
          }),
      ),
    ),
  );

/** A provisioned Worker whose last machine creation failed, and when it tries again. */
export class ProvisioningPauseView extends Schema.Class<ProvisioningPauseView>(
  "@usine/orchestrator/ProvisioningPauseView",
)({
  /** Why the creation failed, or `check` if the first machine of the day failed its preflight. */
  reason: Schema.Union([MachineUnavailableReason, Schema.Literal("check")]),
  message: Schema.String,
  /** The number of failed creations in a row. */
  failures: Schema.Int,
  failedAt: Schema.String,
  retryAt: Schema.String,
  /** Whether the Worker waits for `retryAt` before it creates a machine. */
  blocked: Schema.Boolean,
}) {}

/** A Hetzner Cloud provisioner from `usine.yaml`, with the names of its variables only. */
export class HetznerProvisionerView extends Schema.TaggedClass<HetznerProvisionerView>(
  "@usine/orchestrator/HetznerProvisionerView",
)("hetzner", {
  tokenEnv: Schema.String,
  serverType: HetznerServerType,
  location: HetznerLocation,
  image: HetznerImage,
  network: Schema.NullOr(HetznerResourceName),
  firewall: Schema.NullOr(HetznerResourceName).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  sshKey: HetznerResourceName,
  sshUser: SshUser,
  labels: Schema.Record(Schema.String, Schema.String),
  /** The variable with the Anthropic API key for each Attempt, or null. */
  anthropicKeyEnv: Schema.NullOr(Schema.String),
  /** The variable with the OpenAI API key for each Attempt, or null. */
  openaiKeyEnv: Schema.NullOr(Schema.String),
}) {}

/** A Boat provisioner from `usine.yaml`, with the names of its variables only. */
export class BoatProvisionerView extends Schema.TaggedClass<BoatProvisionerView>(
  "@usine/orchestrator/BoatProvisionerView",
)("boat", {
  tokenEnv: Schema.String,
  size: BoatSize,
  /** The variable with the Anthropic API key for each Attempt, or null. */
  anthropicKeyEnv: Schema.NullOr(Schema.String),
  /** The variable with the OpenAI API key for each Attempt, or null. */
  openaiKeyEnv: Schema.NullOr(Schema.String),
}) {}

export const ProvisionerView = Schema.Union([HetznerProvisionerView, BoatProvisionerView]);
export type ProvisionerView = typeof ProvisionerView.Type;

export const machineView = (machine: MachineStatus): MachineView =>
  new MachineView({
    worker: machine.worker,
    provider: machine.provider,
    state: machine.state,
    id: Option.getOrNull(machine.id),
    runId: Option.getOrNull(machine.runId),
    attemptId: Option.getOrNull(machine.attemptId),
    since: DateTime.formatIso(machine.since),
  });

export const provisioningPauseView = (pause: ProvisioningPause): ProvisioningPauseView =>
  new ProvisioningPauseView({
    reason: pause.reason,
    message: pause.message,
    failures: pause.failures,
    failedAt: DateTime.formatIso(pause.failedAt),
    retryAt: DateTime.formatIso(pause.retryAt),
    blocked: pause.blocked,
  });

/** Returns the operator view of an SSH Worker's provisioner, or null for a long-lived machine. */
export const provisionerView = (worker: SshWorker): ProvisionerView | null =>
  Option.match(worker.provisioner, {
    onNone: () => null,
    onSome: (settings): ProvisionerView =>
      settings.provider === "hetzner"
        ? new HetznerProvisionerView({
            tokenEnv: settings.tokenEnv,
            serverType: settings.serverType,
            location: settings.location,
            image: settings.image,
            network: Option.getOrNull(settings.network),
            firewall: Option.getOrNull(settings.firewall),
            sshKey: settings.sshKey,
            sshUser: settings.sshUser,
            labels: settings.labels,
            anthropicKeyEnv: Option.getOrNull(settings.apiKeys.anthropic),
            openaiKeyEnv: Option.getOrNull(settings.apiKeys.openai),
          })
        : new BoatProvisionerView({
            tokenEnv: settings.tokenEnv,
            size: settings.size,
            anthropicKeyEnv: Option.getOrNull(settings.apiKeys.anthropic),
            openaiKeyEnv: Option.getOrNull(settings.apiKeys.openai),
          }),
  });

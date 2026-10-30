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

/** A quota refusal that prevents a run's leased worker from creating its machine. */
export class MachineQuotaWait extends Schema.Class<MachineQuotaWait>(
  "@usine/orchestrator/MachineQuotaWait",
)({
  /** The worker assigned to the run. */
  worker: WorkerName,
  /** The provider's quota refusal. */
  message: Schema.String,
}) {}

export const quotaWaits = (
  pauses: ReadonlyArray<ProvisioningPause>,
): ReadonlyMap<RunId, MachineQuotaWait> =>
  new Map(
    pauses.flatMap((pause) =>
      Option.match(pause.quota, {
        onNone: () => [],
        onSome: (message) =>
          pause.waitingRuns.map(
            (runId) => [runId, new MachineQuotaWait({ worker: pause.worker, message })] as const,
          ),
      }),
    ),
  );

/** A machine that a provisioned Worker created for one Attempt and hasn't deleted yet. */
export class MachineView extends Schema.Class<MachineView>("@usine/orchestrator/MachineView")({
  /** The configured worker name. */
  worker: WorkerName,
  /** The provider hosting this attempt machine. */
  provider: MachineProvider,
  /** The machine lifecycle state reported by the executor. */
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

/** A provisioned Worker whose last machine creation failed, and when it tries again. */
export class ProvisioningPauseView extends Schema.Class<ProvisioningPauseView>(
  "@usine/orchestrator/ProvisioningPauseView",
)({
  /** Why the creation failed, or `check` if the first machine of the day failed its preflight. */
  reason: Schema.Union([MachineUnavailableReason, Schema.Literal("check")]),
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
  /** The number of failed creations in a row. */
  failures: Schema.Int,
  /** The most recent machine creation or preflight failure time. */
  failedAt: Schema.String,
  /** The earliest time to try creating a machine again. */
  retryAt: Schema.String,
  /** Whether the Worker waits for `retryAt` before it creates a machine. */
  blocked: Schema.Boolean,
}) {}

/** A Hetzner Cloud provisioner from `usine.yaml`, with the names of its variables only. */
export class HetznerProvisionerView extends Schema.TaggedClass<HetznerProvisionerView>(
  "@usine/orchestrator/HetznerProvisionerView",
)("hetzner", {
  /** The environment-variable name for the Hetzner API token, never its value. */
  tokenEnv: Schema.String,
  /** The Hetzner server type to create. */
  serverType: HetznerServerType,
  /** The Hetzner location for new machines. */
  location: HetznerLocation,
  /** The image used to initialize new machines. */
  image: HetznerImage,
  /** The Hetzner private network name, or null without one. */
  network: Schema.NullOr(HetznerResourceName),
  /** The Hetzner firewall name, or null without one. */
  firewall: Schema.NullOr(HetznerResourceName).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The registered Hetzner SSH key name. */
  sshKey: HetznerResourceName,
  /** The SSH login user for created machines. */
  sshUser: SshUser,
  /** Labels applied to created Hetzner machines. */
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
  /** The environment-variable name for the Boat API token, never its value. */
  tokenEnv: Schema.String,
  /** The Boat machine size to create. */
  size: BoatSize,
  /** The variable with the Anthropic API key for each Attempt, or null. */
  anthropicKeyEnv: Schema.NullOr(Schema.String),
  /** The variable with the OpenAI API key for each Attempt, or null. */
  openaiKeyEnv: Schema.NullOr(Schema.String),
}) {}

/**
 * Provisioner settings safe to return to operator clients; credentials appear only as
 * environment-variable names.
 */
export const ProvisionerView = Schema.Union([HetznerProvisionerView, BoatProvisionerView]);
/**
 * Provisioner settings safe to return to operator clients; credentials appear only as
 * environment-variable names.
 */
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

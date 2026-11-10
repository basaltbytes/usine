import { BoxdRegion, MachineId } from "@usine/core/worker";
import { type Brand, Context, Effect, Schema } from "effect";

export class BoxdCallError extends Schema.TaggedError<
  BoxdCallError,
  Brand.Brand<"@usine/executor/boxd/BoxdCallError">
>()("BoxdCallError", {
  operation: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

/** The error when boxd lists no region with the configured id; `available` lists the ids it has. */
export class BoxdUnknownRegion extends Schema.TaggedError<
  BoxdUnknownRegion,
  Brand.Brand<"@usine/executor/boxd/BoxdUnknownRegion">
>()("BoxdUnknownRegion", {
  region: BoxdRegion,
  available: Schema.Array(Schema.String),
}) {}

export const BoxdMachine = Schema.Struct({
  id: MachineId,
  publicIp: Schema.String,
  status: Schema.NonEmptyString,
  sshPort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  sshDisabled: Schema.Boolean,
  createdAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000 })),
  labels: Schema.Record(Schema.String, Schema.String),
  /** The machine's egress allowlist; empty when its egress is unrestricted. */
  egressAllow: Schema.Array(Schema.String),
});
export type BoxdMachine = typeof BoxdMachine.Type;

export const BoxdSnapshot = Schema.Struct({
  status: Schema.NonEmptyString,
  region: Schema.String,
  vcpu: Schema.Int,
  memoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BoxdSnapshot = typeof BoxdSnapshot.Type;

export const BoxdRegions = Schema.Struct({ thisRegion: Schema.String });
export const BoxdLimit = Schema.Struct({ maxVms: Schema.Int, vmCount: Schema.Int });
export const BoxdIdentity = Schema.Struct({
  userId: Schema.NonEmptyString,
  sshKeyFingerprints: Schema.Array(Schema.String),
});
export const BoxdCreated = Schema.Struct({
  id: MachineId,
  machine: Schema.OptionFromOptionalKey(BoxdMachine),
});

export interface BoxdCreate {
  readonly snapshot: string;
  readonly name: string;
  readonly isolated: boolean;
  readonly labels: Record<string, string>;
  readonly config: { readonly network: { readonly ssh: true } };
}

/** Transport boundary: responses contain only decoded values used by the driver. */
export class BoxdApi extends Context.Service<
  BoxdApi,
  {
    readonly whoami: Effect.Effect<typeof BoxdIdentity.Type, BoxdCallError>;
    readonly orgMachineLimit: Effect.Effect<typeof BoxdLimit.Type, BoxdCallError>;
    readonly snapshot: (name: string) => Effect.Effect<BoxdSnapshot, BoxdCallError>;
    readonly regions: Effect.Effect<typeof BoxdRegions.Type, BoxdCallError>;
    readonly createFromSnapshot: (
      request: BoxdCreate,
    ) => Effect.Effect<typeof BoxdCreated.Type, BoxdCallError>;
    readonly vm: (id: MachineId) => Effect.Effect<BoxdMachine, BoxdCallError>;
    readonly listVms: (
      selector: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<BoxdMachine>, BoxdCallError>;
    readonly sshHostKey: Effect.Effect<string, BoxdCallError>;
    readonly updateLabels: (
      id: MachineId,
      set: Record<string, string>,
    ) => Effect.Effect<void, BoxdCallError>;
    readonly destroy: (id: MachineId) => Effect.Effect<void, BoxdCallError>;
    /**
     * Replaces the machine's egress allowlist; an empty list makes egress unrestricted. Returns
     * the list in effect.
     */
    readonly setEgressAllow: (
      id: MachineId,
      entries: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, BoxdCallError>;
    readonly setAutoHibernateTimeout: (
      id: MachineId,
      seconds: number,
    ) => Effect.Effect<void, BoxdCallError>;
    readonly setAutoSuspendTimeout: (
      id: MachineId,
      seconds: number,
    ) => Effect.Effect<void, BoxdCallError>;
  }
>()("@usine/executor/ssh/provisioner/boxd/client/BoxdApi") {}

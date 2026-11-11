import { BoxdRegion, MachineId } from "@usine/core/worker";
import {
  type Brand,
  Context,
  Effect,
  type Layer,
  type Option,
  type Redacted,
  Schema,
} from "effect";
import type { HttpClient } from "effect/http";

export class BoxdCallError extends Schema.TaggedError<
  BoxdCallError,
  Brand.Brand<"@usine/executor/boxd/BoxdCallError">
>()("BoxdCallError", {
  operation: Schema.String,
  /** The URL that the call went to: a gRPC endpoint, or the token exchange URL. */
  url: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

/**
 * The error when boxd lists no region with the configured id, or lists it without an API endpoint;
 * `available` lists the ids of the regions that boxd can serve, empty when boxd runs in one place.
 */
export class BoxdUnknownRegion extends Schema.TaggedError<
  BoxdUnknownRegion,
  Brand.Brand<"@usine/executor/boxd/BoxdUnknownRegion">
>()("BoxdUnknownRegion", {
  region: BoxdRegion,
  available: Schema.Array(Schema.String),
}) {}

export const BoxdMachine = Schema.Struct({
  id: MachineId,
  status: Schema.NonEmptyString,
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
  /**
   * Where boxd keeps the snapshot: `local`, `archiving`, `archived`, or `unarchiving`. boxd
   * creates machines only from a `local` snapshot. Empty when boxd doesn't report it.
   */
  storage: Schema.String,
});
export type BoxdSnapshot = typeof BoxdSnapshot.Type;

/** A `ListRegions` response: every region with its API endpoint, and the region that answered. */
export const BoxdRegionList = Schema.Struct({
  regions: Schema.Array(Schema.Struct({ id: Schema.String, apiEndpoint: Schema.String })),
  thisRegion: Schema.String,
});
export const BoxdLimit = Schema.Struct({ maxVms: Schema.Int, vmCount: Schema.Int });
export const BoxdIdentity = Schema.Struct({ userId: Schema.NonEmptyString });
export const BoxdCreated = Schema.Struct({
  id: MachineId,
  machine: Schema.OptionFromOptionalKey(BoxdMachine),
});

export interface BoxdCreate {
  readonly snapshot: string;
  readonly name: string;
  readonly isolated: boolean;
  readonly labels: Record<string, string>;
}

/** Transport boundary: responses contain only decoded values used by the driver. */
export class BoxdApi extends Context.Service<
  BoxdApi,
  {
    /**
     * The API endpoint URL of the machines' region, which serves their machine and `Exec` calls.
     * Without a configured region, or for the region that the account endpoint serves, it is the
     * account endpoint.
     */
    readonly endpoint: string;
    readonly whoami: Effect.Effect<typeof BoxdIdentity.Type, BoxdCallError>;
    readonly orgMachineLimit: Effect.Effect<typeof BoxdLimit.Type, BoxdCallError>;
    readonly snapshot: (name: string) => Effect.Effect<BoxdSnapshot, BoxdCallError>;
    /**
     * The region that `endpoint` serves, `""` when boxd runs in one place. With a configured
     * region, it is that region, without a call; otherwise boxd reports it.
     */
    readonly servedRegion: Effect.Effect<string, BoxdCallError>;
    readonly createFromSnapshot: (
      request: BoxdCreate,
    ) => Effect.Effect<typeof BoxdCreated.Type, BoxdCallError>;
    readonly vm: (id: MachineId) => Effect.Effect<BoxdMachine, BoxdCallError>;
    readonly listVms: (
      selector: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<BoxdMachine>, BoxdCallError>;
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

/** Where the calls of a boxd Worker go. */
export interface BoxdCluster {
  /** The account endpoint URL, which serves account calls and `ListRegions`. */
  readonly endpoint: string;
  /** The region of the machines, or `None` to send every call to `endpoint`. */
  readonly region: Option.Option<BoxdRegion>;
}

/**
 * Builds the `BoxdApi` of `cluster` with the API key `token`. Building fails when boxd refuses the
 * key, doesn't answer, or lists no such region.
 */
export type BoxdApiLayer = (
  token: Redacted.Redacted<string>,
  cluster: BoxdCluster,
) => Layer.Layer<BoxdApi, BoxdCallError | BoxdUnknownRegion, HttpClient.HttpClient>;

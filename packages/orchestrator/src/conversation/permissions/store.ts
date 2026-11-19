import type { ConversationId, TurnId } from "@usine/core/conversation";
import type {
  AllowedRequest,
  GrantRevocation,
  PermissionRequest,
  PermissionRequestId,
  StandingGrant,
  StandingGrantId,
} from "@usine/core/permission-request";
import { type Brand, Context, type Effect, type Option, Schema } from "effect";

/** The permission store couldn't read or write. */
export class PermissionStoreError extends Schema.TaggedError<
  PermissionStoreError,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/store/PermissionStoreError">
>("@usine/orchestrator/PermissionStoreError")("PermissionStoreError", {
  operation: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** The stored request is no longer in the state that a transition starts from. */
export class RequestConflict extends Schema.TaggedError<
  RequestConflict,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/store/RequestConflict">
>("@usine/orchestrator/RequestConflict")("RequestConflict", {
  request: Schema.NonEmptyString,
  expected: Schema.NonEmptyString,
}) {}

/**
 * Stores supervisor turns' permission requests and members' standing grants. Every write is
 * atomic.
 */
export class PermissionStore extends Context.Service<
  PermissionStore,
  {
    /**
     * Stores a new request. With `used`, records in the same write that a call ran under that
     * grant at the request's time.
     */
    readonly create: (
      request: PermissionRequest,
      used: Option.Option<StandingGrantId>,
    ) => Effect.Effect<void, PermissionStoreError>;
    /**
     * Replaces the stored `from` with `to`, which must have the same ID. With `grant`, stores the
     * grant in the same write.
     */
    readonly transition: (
      from: PermissionRequest,
      to: PermissionRequest,
      grant: Option.Option<StandingGrant>,
    ) => Effect.Effect<void, PermissionStoreError | RequestConflict>;
    readonly get: (
      id: PermissionRequestId,
    ) => Effect.Effect<Option.Option<PermissionRequest>, PermissionStoreError>;
    /** The requests of a conversation, oldest first. */
    readonly ofConversation: (
      conversation: ConversationId,
    ) => Effect.Effect<ReadonlyArray<PermissionRequest>, PermissionStoreError>;
    /** The requests of a turn, oldest first. */
    readonly ofTurn: (
      turn: TurnId,
    ) => Effect.Effect<ReadonlyArray<PermissionRequest>, PermissionStoreError>;
    /** The requests whose call was allowed and has no stored outcome. */
    readonly running: Effect.Effect<ReadonlyArray<AllowedRequest>, PermissionStoreError>;
    /** The turns with a request that a member answered and no turn reported yet. */
    readonly unreported: Effect.Effect<ReadonlyArray<TurnId>, PermissionStoreError>;
    /** Marks the requests of `turn` that a member answered as reported in `followUp`. */
    readonly report: (turn: TurnId, followUp: TurnId) => Effect.Effect<void, PermissionStoreError>;
    /** The allowed calls, latest answer first, at most `limit`. */
    readonly actions: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PermissionRequest>, PermissionStoreError>;
    /** The grants that are not revoked, oldest first. */
    readonly grants: Effect.Effect<ReadonlyArray<StandingGrant>, PermissionStoreError>;
    readonly grant: (
      id: StandingGrantId,
    ) => Effect.Effect<Option.Option<StandingGrant>, PermissionStoreError>;
    /**
     * Revokes the grant `id` unless it is revoked already, and returns the stored grant, or `None`
     * when no grant has the ID.
     */
    readonly revoke: (
      id: StandingGrantId,
      revocation: GrantRevocation,
    ) => Effect.Effect<Option.Option<StandingGrant>, PermissionStoreError>;
  }
>()("@usine/orchestrator/conversation/permissions/store/PermissionStore") {}

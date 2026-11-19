import type { PostingCredential, TurnMember } from "@usine/core/conversation";
import type {
  CallOutcome,
  OperationCall,
  OperationRequirement,
} from "@usine/core/permission-request";
import { type Brand, Context, type Effect, Schema } from "effect";

/** A member, and the credential they answered or posted with. */
export interface Actor {
  readonly member: TurnMember;
  readonly credential: PostingCredential;
}

/** The member can't act now: they were removed, or the credential was revoked or expired. */
export class ActorRefused extends Schema.TaggedError<
  ActorRefused,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/acting/ActorRefused">
>("@usine/orchestrator/ActorRefused")("ActorRefused", {
  message: Schema.NonEmptyString,
}) {}

/** What a member's credential can do now. */
export interface ActorAccess {
  /** Whether the access permits the operation in its scope, within the token's operation ceiling. */
  readonly permits: (requirement: OperationRequirement) => boolean;
}

/**
 * Runs operator operations as a member, for the calls that members allow. The server provides it,
 * since the calls go through its operator API with the member's access, so the route checks and
 * the audit of the operation apply.
 */
export class ActingCalls extends Context.Service<
  ActingCalls,
  {
    /** The current access of `actor`, recomputed from the member's role bindings and credential. */
    readonly access: (actor: Actor) => Effect.Effect<ActorAccess, ActorRefused>;
    /**
     * Runs `call` as `actor` with a credential that can call only the call's operation, in its
     * scope, and returns the operation's response, cut as a tool result is.
     */
    readonly run: (actor: Actor, call: OperationCall) => Effect.Effect<CallOutcome>;
  }
>()("@usine/orchestrator/conversation/permissions/acting/ActingCalls") {}

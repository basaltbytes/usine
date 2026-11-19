import type { Harnesses, UnknownHarnessError } from "@usine/agents/harness/registry";
import type {
  SupervisorReply,
  SupervisorTurn,
  SupervisorTurnError,
} from "@usine/agents/supervisor";
import type { AccessScope, PermissionGrant } from "@usine/core/access";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import type { PostingCredential, TurnMember } from "@usine/core/conversation";
import type { OperationCall, PermissionRequest } from "@usine/core/permission-request";
import { type Brand, Context, type Effect, type Option, Schema, type Scope } from "effect";
import type { CallOutsideScope } from "./permissions/permissions.ts";
import type { PermissionStoreError } from "./permissions/store.ts";

/** The member can't act for a turn, such as a member who was removed. */
export class TurnAccessError extends Schema.TaggedError<
  TurnAccessError,
  Brand.Brand<"@usine/orchestrator/conversation/access/TurnAccessError">
>("@usine/orchestrator/TurnAccessError")("TurnAccessError", {
  message: Schema.NonEmptyString,
}) {}

/** Where a turn's calls of operations that need more than `read` go. */
export interface TurnRequests {
  /**
   * Runs `call` under a standing grant that covers it, or stores a waiting permission request,
   * and returns the request. `toolCall` is the harness's ID of the tool call.
   */
  readonly call: (
    call: OperationCall,
    toolCall: Option.Option<string>,
  ) => Effect.Effect<PermissionRequest, CallOutsideScope | PermissionStoreError>;
}

/** What one turn can do and know as the member who posted its message. */
export interface MemberTurns {
  /** The current grants of the credential that posted the message, within the member's grants. */
  readonly posterGrants: ReadonlyArray<PermissionGrant>;
  /** The turn's grants when it starts: `read` on its scope if the posting credential has it. */
  readonly grants: ReadonlyArray<PermissionGrant>;
  /** The needs-you entries that the turn can read, at most `NEEDS_LIMIT`, as JSON text. */
  readonly needsYou: ReadonlyArray<string>;
  /** How many needs-you entries the turn can read in all. */
  readonly needsTotal: number;
  /**
   * Runs `turn` with the read operator tools that the turn's grants and the posting token's
   * operation ceiling allow, and the operator tools that need more than `read`, whose calls go to
   * the turn's requests.
   */
  readonly run: (
    turn: SupervisorTurn,
    observe: (event: AgentSessionEvent) => Effect.Effect<void>,
  ) => Effect.Effect<SupervisorReply, SupervisorTurnError | UnknownHarnessError, Harnesses>;
}

/** The most needs-you entries that a turn's context lists. */
export const NEEDS_LIMIT = 20;

/**
 * Gives a turn read access in `scope` as the member who posted its message with `credential`,
 * and sends its other operator calls to `requests`. Fails when the member was removed or the
 * posting token was revoked or expired. The server provides it, since the operator tools answer
 * through its API with a credential that lives until the scope closes.
 */
export class TurnAccess extends Context.Service<
  TurnAccess,
  {
    readonly open: (
      member: TurnMember,
      credential: PostingCredential,
      scope: AccessScope,
      requests: TurnRequests,
    ) => Effect.Effect<MemberTurns, TurnAccessError, Scope.Scope>;
  }
>()("@usine/orchestrator/conversation/access/TurnAccess") {}

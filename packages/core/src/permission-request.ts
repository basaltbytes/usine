import { type Brand, type DateTime, Option, Schema } from "effect";
import { AccessScope, InstanceScope, PermissionGrant, ProjectScope } from "./access.ts";
import { ConversationId, PostingCredential, TurnId, TurnMember } from "./conversation.ts";
import { OperatorLogin } from "./operator.ts";
import { ProjectId } from "./project.ts";

/** The ID of a permission request. */
export const PermissionRequestId = Schema.NonEmptyString.pipe(Schema.brand("PermissionRequestId"));
export type PermissionRequestId = typeof PermissionRequestId.Type;

/** The ID of a standing grant. */
export const StandingGrantId = Schema.NonEmptyString.pipe(Schema.brand("StandingGrantId"));
export type StandingGrantId = typeof StandingGrantId.Type;

/** An operator operation by its endpoint identifier, such as `retry`. */
export const OperationName = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z]*$/u, { message: "Expected an operation name, such as retry" }),
).pipe(Schema.brand("OperationName"));
export type OperationName = typeof OperationName.Type;

/** The permission that an operation needs beyond `read`. */
export const WritePermission = Schema.Literals(["operate", "maintain", "admin"]);
export type WritePermission = typeof WritePermission.Type;

/** What a call acts on, in words, such as `run 4f2c` or `acme/web#42`; at most 300 characters. */
export const CallTarget = Schema.NonEmptyString.check(Schema.isMaxLength(300)).pipe(
  Schema.brand("CallTarget"),
);
export type CallTarget = typeof CallTarget.Type;

/** A turn's call of an operator operation that needs more than `read`. */
export class OperationCall extends Schema.Class<
  OperationCall,
  Brand.Brand<"@usine/core/permission-request/OperationCall">
>("PermissionRequest/OperationCall")({
  operation: OperationName,
  /** The operation's summary, such as `Retry a failed run`. */
  summary: Schema.NonEmptyString,
  /** The tool arguments: path and query parameters by name, and `body`. */
  arguments: Schema.Record(Schema.String, Schema.Json),
  target: CallTarget,
  /**
   * Where the operation's permission is checked: the project of the target, or the instance for
   * operations outside a project, such as upgrades, configuration writes, and worker operations.
   */
  scope: AccessScope,
  permission: WritePermission,
}) {}

/** What a permission check needs to know about an operation. */
export interface OperationRequirement {
  readonly operation: OperationName;
  readonly permission: WritePermission;
  readonly scope: AccessScope;
}

/**
 * The operations that send free text to a coding agent that can push: an operator message, and
 * the task of an edit-and-retry or a run-again. A standing grant never covers them, so text from a
 * pull request or an issue can't reach an agent without a member reading it first.
 */
const FREE_TEXT_OPERATIONS: ReadonlySet<string> = new Set([
  "intervene",
  "editAndRetry",
  "runAgain",
]);

/**
 * Whether a standing grant can cover `call`: a call in a project of an operation that sends no
 * free text to a coding agent.
 */
export const isGrantable = (call: OperationRequirement): boolean =>
  call.scope._tag === "Project" && !FREE_TEXT_OPERATIONS.has(call.operation);

/**
 * Returns the grants that a credential limited to `requirement` has, within a member's grants:
 * `read` and the operation's permission on its scope, or instance admin for an admin operation.
 */
export const callCeiling = (requirement: OperationRequirement): ReadonlyArray<PermissionGrant> =>
  requirement.permission === "admin"
    ? [PermissionGrant.make({ permission: "admin", scope: InstanceScope.make() })]
    : [
        PermissionGrant.make({ permission: "read", scope: requirement.scope }),
        PermissionGrant.make({ permission: requirement.permission, scope: requirement.scope }),
      ];

/** How a member answers a permission request. */
export const Answer = Schema.Literals(["once", "always", "deny"]);
export type Answer = typeof Answer.Type;

/** A member allowed the call once. */
export class AllowedOnce extends Schema.TaggedClass<
  AllowedOnce,
  Brand.Brand<"@usine/core/permission-request/AllowedOnce">
>("Allowance/AllowedOnce")("AllowedOnce", {
  by: TurnMember,
  at: Schema.DateTimeUtc,
}) {}

/** A member allowed the call and stored a standing grant for its operation in its project. */
export class AllowedAlways extends Schema.TaggedClass<
  AllowedAlways,
  Brand.Brand<"@usine/core/permission-request/AllowedAlways">
>("Allowance/AllowedAlways")("AllowedAlways", {
  by: TurnMember,
  at: Schema.DateTimeUtc,
  grant: StandingGrantId,
}) {}

/** A standing grant covered the call, so it ran without waiting for a member. */
export class CoveredByGrant extends Schema.TaggedClass<
  CoveredByGrant,
  Brand.Brand<"@usine/core/permission-request/CoveredByGrant">
>("Allowance/CoveredByGrant")("CoveredByGrant", {
  /** The member whose grant covered the call. */
  by: TurnMember,
  at: Schema.DateTimeUtc,
  grant: StandingGrantId,
}) {}

/** Who allowed a call, and how. */
export const Allowance = Schema.Union([AllowedOnce, AllowedAlways, CoveredByGrant]);
export type Allowance = typeof Allowance.Type;

/** The request waits for a member's answer. */
export class RequestWaiting extends Schema.TaggedClass<
  RequestWaiting,
  Brand.Brand<"@usine/core/permission-request/RequestWaiting">
>("RequestState/Waiting")("Waiting", {}) {}

/** A member denied the request; nothing ran. */
export class RequestDenied extends Schema.TaggedClass<
  RequestDenied,
  Brand.Brand<"@usine/core/permission-request/RequestDenied">
>("RequestState/Denied")("Denied", {
  by: TurnMember,
  at: Schema.DateTimeUtc,
}) {}

/** The call was allowed and runs. */
export class RequestAllowed extends Schema.TaggedClass<
  RequestAllowed,
  Brand.Brand<"@usine/core/permission-request/RequestAllowed">
>("RequestState/Allowed")("Allowed", {
  allowance: Allowance,
}) {}

/** The call ran and the operation succeeded. */
export class RequestRan extends Schema.TaggedClass<
  RequestRan,
  Brand.Brand<"@usine/core/permission-request/RequestRan">
>("RequestState/Ran")("Ran", {
  allowance: Allowance,
  endedAt: Schema.DateTimeUtc,
  /** The operation's response, as the supervisor reads it. */
  result: Schema.String,
}) {}

/** The call ran and the operation refused or failed. */
export class RequestFailed extends Schema.TaggedClass<
  RequestFailed,
  Brand.Brand<"@usine/core/permission-request/RequestFailed">
>("RequestState/Failed")("Failed", {
  allowance: Allowance,
  endedAt: Schema.DateTimeUtc,
  /** The error, such as `HTTP 409` and the operation's message. */
  error: Schema.NonEmptyString,
}) {}

/**
 * usine stopped while the call ran, before it stored the outcome. The call may or may not have
 * changed the factory; usine never runs it again.
 */
export class RequestInterrupted extends Schema.TaggedClass<
  RequestInterrupted,
  Brand.Brand<"@usine/core/permission-request/RequestInterrupted">
>("RequestState/Interrupted")("Interrupted", {
  allowance: Allowance,
  endedAt: Schema.DateTimeUtc,
}) {}

/**
 * The permission request state machine:
 *
 *   waiting ──► denied
 *   waiting ──► allowed ──► ran | failed | interrupted
 *
 * A call that a standing grant covers starts as allowed. Each transition accepts only a request in
 * its legal source state, so a request is answered once.
 */
export const RequestState = Schema.Union([
  RequestWaiting,
  RequestDenied,
  RequestAllowed,
  RequestRan,
  RequestFailed,
  RequestInterrupted,
]);
export type RequestState = typeof RequestState.Type;

/**
 * A turn's call of an operation that needs more than `read`, which runs only once a member allows
 * it or a standing grant covers it.
 */
export class PermissionRequest extends Schema.Class<
  PermissionRequest,
  Brand.Brand<"@usine/core/permission-request/PermissionRequest">
>("PermissionRequest/PermissionRequest")({
  id: PermissionRequestId,
  conversation: ConversationId,
  /** The scope of the conversation; its readers can read the request. */
  audience: AccessScope,
  turn: TurnId,
  /** The harness's ID of the tool call, which places the request among the turn's events. */
  toolCall: Schema.OptionFromNullOr(Schema.NonEmptyString),
  call: OperationCall,
  requestedAt: Schema.DateTimeUtc,
  state: RequestState,
  /** The turn that reported the outcome to the supervisor, once usine queued it. */
  reportedIn: Schema.OptionFromNullOr(TurnId),
}) {}

export type WaitingRequest = PermissionRequest & { readonly state: RequestWaiting };
export type AllowedRequest = PermissionRequest & { readonly state: RequestAllowed };

export const isWaiting = (request: PermissionRequest): request is WaitingRequest =>
  request.state._tag === "Waiting";
export const isAllowed = (request: PermissionRequest): request is AllowedRequest =>
  request.state._tag === "Allowed";

/** Whether a member answered the request, rather than a standing grant covering it. */
export const answeredByMember = ({ state }: PermissionRequest): boolean =>
  state._tag === "Denied" ||
  ((state._tag === "Allowed" ||
    state._tag === "Ran" ||
    state._tag === "Failed" ||
    state._tag === "Interrupted") &&
    state.allowance._tag !== "CoveredByGrant");

/** When a member answered `request` or a standing grant covered it, or `None` while it waits. */
export const answeredAt = ({ state }: PermissionRequest): Option.Option<DateTime.Utc> => {
  switch (state._tag) {
    case "Waiting":
      return Option.none();
    case "Denied":
      return Option.some(state.at);
    default:
      return Option.some(state.allowance.at);
  }
};

type RequestFields = Omit<Parameters<typeof PermissionRequest.make>[0], "state">;

// SAFETY: `PermissionRequest.make` checks `state` against `RequestState` and keeps the `state` passed in.
const withState = <S extends RequestState>(request: RequestFields, state: S) =>
  PermissionRequest.make({ ...request, state }) as PermissionRequest & { readonly state: S };

/** Returns a new request for `call`, waiting for a member. */
export const requested = (request: Omit<RequestFields, "reportedIn">): WaitingRequest =>
  withState({ ...request, reportedIn: Option.none() }, RequestWaiting.make({}));

/** Returns a new request for `call` that `grant` covers, allowed and about to run. */
export const covered = (
  request: Omit<RequestFields, "reportedIn">,
  allowance: CoveredByGrant,
): AllowedRequest =>
  withState({ ...request, reportedIn: Option.none() }, RequestAllowed.make({ allowance }));

export const deny = (request: WaitingRequest, by: TurnMember, at: DateTime.Utc) =>
  withState(request, RequestDenied.make({ by, at }));

export const allow = (request: WaitingRequest, allowance: AllowedOnce | AllowedAlways) =>
  withState(request, RequestAllowed.make({ allowance }));

/** What running an allowed call returned. */
export type CallOutcome =
  | { readonly _tag: "Succeeded"; readonly result: string }
  | { readonly _tag: "Refused"; readonly error: string };

export const settle = (request: AllowedRequest, at: DateTime.Utc, outcome: CallOutcome) => {
  const { allowance } = request.state;
  return outcome._tag === "Succeeded"
    ? withState(request, RequestRan.make({ allowance, endedAt: at, result: outcome.result }))
    : withState(
        request,
        RequestFailed.make({
          allowance,
          endedAt: at,
          error: outcome.error === "" ? "The operation failed." : outcome.error,
        }),
      );
};

export const interrupt = (request: AllowedRequest, at: DateTime.Utc) =>
  withState(request, RequestInterrupted.make({ allowance: request.state.allowance, endedAt: at }));

/**
 * Returns whether usine reports the requests of one turn to the supervisor now: none waits or runs,
 * and a member answered one that no turn reported yet. Calls that a standing grant covered
 * returned their result to the turn that made them.
 */
export const needsReport = (requests: ReadonlyArray<PermissionRequest>): boolean =>
  requests.some((request) => answeredByMember(request) && Option.isNone(request.reportedIn)) &&
  !requests.some((request) => isWaiting(request) || isAllowed(request));

/** Returns `request` reported in `turn` if a member answered it, else unchanged. */
export const reportIn = (request: PermissionRequest, turn: TurnId): PermissionRequest =>
  answeredByMember(request) && Option.isNone(request.reportedIn)
    ? PermissionRequest.make({ ...request, reportedIn: Option.some(turn) })
    : request;

const projectOf = ({ scope }: OperationCall) =>
  scope._tag === "Project" ? scope.project : "the instance";

/** Who allowed a call, in words. */
const allowedBy = (allowance: Allowance, project: string) => {
  switch (allowance._tag) {
    case "AllowedOnce":
      return `Allowed once by ${allowance.by.login}`;
    case "AllowedAlways":
      return `Allowed always for ${project} by ${allowance.by.login}`;
    case "CoveredByGrant":
      return `Covered by the grant of ${allowance.by.login}`;
  }
};

const firstLine = (text: string) => text.split("\n").find((line) => line.trim() !== "") ?? text;

/** Returns the outcome of `request` as one Markdown list item, for members. */
export const outcomeLine = ({ call, state }: PermissionRequest): string => {
  const what = `- ${call.summary}: ${call.target}.`;
  switch (state._tag) {
    case "Waiting":
      return `${what} Waiting for an answer.`;
    case "Denied":
      return `${what} Denied by ${state.by.login}.`;
    case "Allowed":
      return `${what} ${allowedBy(state.allowance, projectOf(call))}. Running.`;
    case "Ran":
      return `${what} ${allowedBy(state.allowance, projectOf(call))}. Ran.`;
    case "Failed":
      return `${what} ${allowedBy(state.allowance, projectOf(call))}. Failed: ${firstLine(state.error)}`;
    case "Interrupted":
      return `${what} ${allowedBy(state.allowance, projectOf(call))}. Interrupted before usine stored the outcome.`;
  }
};

/** The outcome of one request as the supervisor reads it, and the text that a cap may cut. */
export interface OutcomeData {
  /** The request, operation, arguments, target, project, answer, member, and status. */
  readonly fields: { readonly [key: string]: Schema.Json };
  /** The operation's result or error, under `field`, or `None` when the call has neither. */
  readonly detail: Option.Option<{ readonly field: "result" | "error"; readonly text: string }>;
}

/** Returns the outcome of `request` as the supervisor reads it. */
export const outcomeData = ({ id, call, state }: PermissionRequest): OutcomeData => {
  const fields = {
    request: id,
    operation: call.operation,
    arguments: call.arguments,
    target: call.target,
    project: call.scope._tag === "Project" ? call.scope.project : null,
  };
  switch (state._tag) {
    case "Waiting":
      return { fields: { ...fields, answer: "none", outcome: "waiting" }, detail: Option.none() };
    case "Denied":
      return {
        fields: { ...fields, answer: "denied", by: state.by.login, outcome: "nothing ran" },
        detail: Option.none(),
      };
    default: {
      const answer =
        state.allowance._tag === "AllowedOnce"
          ? "allowed once"
          : state.allowance._tag === "AllowedAlways"
            ? "allowed always for the project"
            : "covered by a standing grant";
      const allowed = { ...fields, answer, by: state.allowance.by.login };
      switch (state._tag) {
        case "Allowed":
          return { fields: { ...allowed, outcome: "running" }, detail: Option.none() };
        case "Ran":
          return {
            fields: { ...allowed, outcome: "ran" },
            detail: Option.some({ field: "result", text: state.result }),
          };
        case "Failed":
          return {
            fields: { ...allowed, outcome: "failed" },
            detail: Option.some({ field: "error", text: state.error }),
          };
        case "Interrupted":
          return {
            fields: {
              ...allowed,
              outcome:
                "interrupted: usine stopped before it stored the outcome, so the call may or may not have run",
            },
            detail: Option.none(),
          };
      }
    }
  }
};

/** Who revoked a standing grant, and when. */
export class GrantRevocation extends Schema.Class<
  GrantRevocation,
  Brand.Brand<"@usine/core/permission-request/GrantRevocation">
>("StandingGrant/GrantRevocation")({
  by: OperatorLogin,
  at: Schema.DateTimeUtc,
}) {}

/**
 * A member's answer that lets supervisor turns run one operation in one project without a
 * permission request. It applies only while the member's access, through the credential they
 * answered with, permits the operation in the project.
 */
export class StandingGrant extends Schema.Class<
  StandingGrant,
  Brand.Brand<"@usine/core/permission-request/StandingGrant">
>("StandingGrant/StandingGrant")({
  id: StandingGrantId,
  operation: OperationName,
  /** The operation's summary, such as `Retry a failed run`. */
  summary: Schema.NonEmptyString,
  permission: WritePermission,
  project: ProjectId,
  /** The member who allowed it. */
  member: TurnMember,
  /** The credential the member answered with; the grant follows its access. */
  credential: PostingCredential,
  /** The request whose answer created it. */
  request: PermissionRequestId,
  createdAt: Schema.DateTimeUtc,
  /** When a call last ran under it. */
  lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  revoked: Schema.OptionFromNullOr(GrantRevocation),
}) {}

/** The permission check of the operation that `grant` covers, in its project. */
export const grantRequirement = (grant: StandingGrant): OperationRequirement => ({
  operation: grant.operation,
  permission: grant.permission,
  scope: ProjectScope.make({ project: grant.project }),
});

/** Whether `grant` covers `call`: it isn't revoked, and has the call's operation and project. */
export const covers = (grant: StandingGrant, call: OperationCall): boolean =>
  Option.isNone(grant.revoked) &&
  grant.operation === call.operation &&
  call.scope._tag === "Project" &&
  call.scope.project === grant.project;

/** Returns `grant` revoked by `revocation`; a revoked grant keeps its first revocation. */
export const revokeGrant = (grant: StandingGrant, revocation: GrantRevocation): StandingGrant =>
  Option.isSome(grant.revoked)
    ? grant
    : StandingGrant.make({ ...grant, revoked: Option.some(revocation) });

/** Returns `grant` with a call that ran under it at `at`; a revoked grant is unchanged. */
export const useGrant = (grant: StandingGrant, at: DateTime.Utc): StandingGrant =>
  Option.isSome(grant.revoked)
    ? grant
    : StandingGrant.make({ ...grant, lastUsedAt: Option.some(at) });

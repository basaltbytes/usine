import { pullRequestFilesRead } from "./files-http.ts";
import { HarnessPresentation } from "@usine/agents/harness";
import {
  describeQuery,
  position,
  repositoryPart,
  changesRead,
  workersRead,
  boardLaneItemsRead,
  taskRunsRead,
} from "./reads.ts";
export { ChangeNotice, ChangeTarget } from "./changes.ts";
import { WorkerPreflightView } from "./preflight.ts";
import { ProjectId } from "@usine/core/project";
import { ProjectView } from "./overview.ts";
import {
  LoopDraft,
  LoopCheck,
  LoopPreviewRequest,
  LoopPreview,
} from "./configuration/loops/model.ts";
export {
  LoopDraft,
  LoopCheck,
  LoopPreviewRequest,
  LoopPreview,
} from "./configuration/loops/model.ts";
import { ConfigProblem } from "@usine/config/file";
import { Harness, Effort } from "@usine/core/agent/brain";
import { RepositoryLabel } from "@usine/github/polling";
import {
  ConfigurationRevisionNumber,
  ConfigurationEntityId,
  ConfigurationEntityKey,
} from "@usine/config/configuration";
import {
  ConfigurationEntityView,
  ConfigurationReplacement,
  ConfigurationRevisionPage,
  ConfigurationRevisionView,
  ConfigurationWrite,
  ConfigurationRevisionQuery,
  ConfigurationEntityRequest,
} from "./configuration/model.ts";
export {
  ConfigurationEntityView,
  ConfigurationReplacement,
  ConfigurationRevisionPage,
  ConfigurationRevisionView,
  ConfigurationWrite,
  ConfigurationRevisionQuery,
  ConfigurationEntityRequest,
} from "./configuration/model.ts";
import { UpgradeRequest, UpgradeView } from "./upgrade.ts";
export { UpgradeRequest, UpgradeView } from "./upgrade.ts";
import { AttentionKey } from "@usine/engine/attention";
import { FileStage, InstancePath } from "@usine/config/file";
import { AttemptId } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { RunAgainResult } from "@usine/engine/engine";
import { TranscriptSequence } from "@usine/engine/transcript";
import { ExecutorOperation, WorkerCapability } from "@usine/executor";
import { type Brand, Effect, Match, Record, Schema, SchemaTransformation } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";
import { RestartBlock } from "../current-instance/changes.ts";
import { ConfigurationWriteProgress, RevisionStep } from "../current-instance/steps.ts";
export {
  ConfigurationSaveId,
  ConfigurationWriteProgress,
  RevisionStep,
} from "../current-instance/steps.ts";
import type { InstanceReloadError } from "../current-instance/current-instance.ts";
import { BoardLaneId } from "./board.ts";
import { CycleBudgetResetView } from "./need.ts";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  TailTranscriptRequest,
} from "./transcript.ts";
import { FactoryOverview } from "./overview.ts";
import { RunDetailView, EditAndRetry, SessionIntervention } from "./run.ts";
import { RunBriefView, RunTextPageView, RunTextPart, RunTranscriptPageView } from "./run-pages.ts";
import { RunGitHubChangesView } from "./github-changes.ts";
import { TaskView } from "./task.ts";
import { ItemView } from "./item.ts";
import { ConfigurationView } from "./configuration/view.ts";
import { ConfigurationSummaryView } from "./configuration/summary.ts";
import { DeskView } from "./desk.ts";
import { RunStatisticsView, StatisticsView, StatisticsWindow } from "./statistics/view.ts";
import { AnchorKey, ConversationId, EventSequence, TurnId } from "@usine/core/conversation";
import { PermissionRequestId, StandingGrantId } from "@usine/core/permission-request";
import {
  AnswerPayload,
  ConversationEventsView,
  ConversationStatusView,
  ConversationsView,
  ConversationView,
  MarkReadPayload,
  MessagePayload,
  PermissionRequestView,
  PostedView,
  ReadMarkerView,
  StandingGrantsView,
  StandingGrantView,
  StartConversationPayload,
  SupervisorActionsView,
  TurnView,
} from "../conversation/view.ts";
export {
  ACTIONS_PAGE,
  AnswerPayload,
  ConversationEventsView,
  ConversationStatusView,
  ConversationSummaryView,
  ConversationsView,
  ConversationView,
  EVENTS_PAGE,
  grantView,
  MarkReadPayload,
  MessagePayload,
  PermissionRequestView,
  PostedView,
  PREVIEW_LENGTH,
  readMarkerView,
  ReadMarkerView,
  requestView,
  StandingGrantsView,
  StandingGrantView,
  StartConversationPayload,
  summaryView,
  SupervisorActionsView,
  turnView,
  TurnView,
} from "../conversation/view.ts";

const errorStatuses = {
  AccessDenied: 403,
  WorkerPreflightRejectedError: 409,
  UpgradeError: 409,
  ConfigurationNotFound: 404,
  ConfigurationStoreError: 500,
  SchemaError: 400,
  InvalidRequestError: 400,
  CrossSiteRequestError: 403,
  RunNotFoundError: 404,
  TranscriptAttemptNotFoundError: 404,
  BoardProjectNotFoundError: 404,
  BoardItemNotFoundError: 404,
  BoardLaneNotFoundError: 404,
  GitHubItemNotFoundError: 404,
  FileChangesNotFoundError: 404,
  PullRequestFilesChangedError: 409,
  RunOperationRejectedError: 409,
  CiNotPassedError: 409,
  RunRetryBlockedError: 409,
  RunInterventionRejectedError: 409,
  LeftoversDiscardRejectedError: 409,
  RosterAgentNotFoundError: 404,
  LoopNotFoundError: 404,
  CycleBudgetResetRejectedError: 409,
  BoardLaneReadOnlyError: 409,
  RestartRequiredError: 409,
  ReloadPreflightError: 409,
  FactoryConfigError: 422,
  EnginePersistenceError: 500,
  AttemptCancellationError: 500,
  HttpBodyError: 500,
  GitHubApiError: 502,
  InvalidGitHubResponseError: 502,
  BackendUnavailableError: 503,
  InstallationDiscoveryError: 503,
  AppPermissionError: 503,
  ProjectNotInstalledError: 503,
  GitHubRateLimitError: 503,
  ConversationNotFound: 404,
  TurnNotFound: 404,
  UnknownProject: 404,
  TurnConflict: 409,
  SupervisorNotReady: 409,
  ConversationStoreError: 500,
  PermissionRequestNotFound: 404,
  RequestAnswered: 409,
  NotGrantable: 400,
  GrantNotFound: 404,
  PermissionStoreError: 500,
} as const;

/**
 * A failed operator request. `error` is the domain failure's tag and `message` is safe to show;
 * persistence details, credentials, and defect causes are never included.
 */
export class OperatorHttpError extends Schema.Error<
  OperatorHttpError,
  Brand.Brand<"@usine/orchestrator/operator/http/OperatorHttpError">
>("@usine/orchestrator/OperatorHttpError")({
  /** The domain failure tag used to select the HTTP status. */
  error: Schema.Literals(Record.keys(errorStatuses)).annotate({
    description: "Domain failure tag that selects the HTTP status.",
  }),
  /** The diagnostic text to show to the operator. */
  message: Schema.String.annotate({ description: "Diagnostic text safe to show to the operator." }),
}) {
  /** The HTTP status for this error. */
  get status() {
    return errorStatuses[this.error];
  }
}

// The envelope uses `error` as its discriminator; `Schema.Error` keeps that wire shape and gives
// browser callers a validated Error.
const errors = [...new Set(Object.values(errorStatuses))].map((status) =>
  OperatorHttpError.check(Schema.makeFilter((error) => error.status === status)).annotate({
    httpApiStatus: status,
  }),
);

/**
 * Server middleware for the operator API that refuses cross-site origins before decoding requests
 * and maps failures to operator envelopes. Servers must provide it; generated clients don't need
 * it.
 */
export class OperatorHttpPolicy extends HttpApiMiddleware.Service<OperatorHttpPolicy>()(
  "@usine/orchestrator/OperatorHttpPolicy",
  {
    /** The operator error envelopes that this middleware can return. */
    error: errors,
  },
) {}

/**
 * The Worker preflight failure behind a refused reload. The check's observation isn't sent to the
 * client.
 */
export const ReloadPreflightFailure = Schema.Union([
  Schema.TaggedStruct("WorkerCapabilityError", {
    worker: WorkerName,
    capability: WorkerCapability,
    message: Schema.String,
  }),
  Schema.TaggedStruct("ExecutorOperationError", {
    operation: ExecutorOperation,
    message: Schema.String,
  }),
  Schema.TaggedStruct("CredentialUnavailableError", {
    repository: RepositoryName,
    message: Schema.String,
  }),
]);
/**
 * The worker preflight failure behind a refused reload. The check's observation isn't sent to the
 * client.
 */
export type ReloadPreflightFailure = typeof ReloadPreflightFailure.Type;

/** A reload refused because `usine.yaml` changed in a way that needs a restart of `usine up`. */
export class RestartRequiredRefusal extends Schema.Error<
  RestartRequiredRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/RestartRequiredRefusal">
>("@usine/orchestrator/RestartRequiredRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("RestartRequiredError"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** The `usine.yaml` blocks that contain the changed fields. */
    blocks: Schema.NonEmptyArray(RestartBlock),
    /**
     * The changed fields as paths into `usine.yaml`, such as `tracing` or
     * `workers.build-1.kind`.
     */
    fields: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
  { httpApiStatus: 409 },
) {}

/** A reload refused because Worker preflight failed for the Agents and Workers it adds. */
export class ReloadPreflightRefusal extends Schema.Error<
  ReloadPreflightRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/ReloadPreflightRefusal">
>("@usine/orchestrator/ReloadPreflightRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("ReloadPreflightError"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** The reloaded Agents whose brains preflight checked on every Worker. */
    agents: Schema.Array(AgentName),
    /** The Workers added or given more slots by the reload, which preflight checked. */
    workers: Schema.Array(WorkerName),
    /** The failed preflight check with observation and credential details omitted. */
    cause: ReloadPreflightFailure,
  },
  { httpApiStatus: 409 },
) {}

/** A reload refused because `usine.yaml` or a file it depends on couldn't be loaded. */
export class FactoryConfigRefusal extends Schema.Error<
  FactoryConfigRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/FactoryConfigRefusal">
>("@usine/orchestrator/FactoryConfigRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("FactoryConfigError"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** The instance-relative configuration file path that failed to load. */
    file: InstancePath,
    /** The read, parse, or validation stage that failed. */
    stage: FileStage,
  },
  { httpApiStatus: 422 },
) {}

/**
 * A configuration write or reload refused because one of its steps, such as the coordinator brain
 * check, ran out of time.
 */
export class ValidationTimeoutRefusal extends Schema.Error<
  ValidationTimeoutRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/ValidationTimeoutRefusal">
>("@usine/orchestrator/ValidationTimeoutRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("ValidationTimeoutError"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** The step of the save or reload that ran out of time. */
    step: RevisionStep,
  },
  { httpApiStatus: 503 },
) {}

/** The reason a reload kept the running instance. */
export type ReloadRefusal =
  | RestartRequiredRefusal
  | ReloadPreflightRefusal
  | FactoryConfigRefusal
  | ValidationTimeoutRefusal;

/** Returns the reload endpoint's refusal for `error`, with `message` for the operator. */
export const reloadRefusal = (error: InstanceReloadError, message: string): ReloadRefusal =>
  Match.valueTags(error, {
    RestartRequiredError: ({ _tag, blocks, fields }) =>
      RestartRequiredRefusal.make({ error: _tag, message, blocks, fields }),
    ReloadPreflightError: ({ _tag, agents, workers, cause }) =>
      ReloadPreflightRefusal.make({
        error: _tag,
        message,
        agents,
        workers,
        cause: Match.valueTags(cause, {
          WorkerCapabilityError: (failure) => ({
            _tag: failure._tag,
            worker: failure.worker,
            capability: failure.capability,
            message: failure.message,
          }),
          ExecutorOperationError: (failure) => ({
            _tag: failure._tag,
            operation: failure.operation,
            message: failure.message,
          }),
          CredentialUnavailableError: (failure) => ({
            _tag: failure._tag,
            repository: failure.repository,
            message: failure.message,
          }),
        }),
      }),
    FactoryConfigError: ({ _tag, file, stage }) =>
      FactoryConfigRefusal.make({ error: _tag, message, file, stage }),
    ValidationTimeoutError: ({ _tag, step }) =>
      ValidationTimeoutRefusal.make({ error: _tag, message, step }),
  });

/** An HTTP 409 response when a configuration write uses an outdated revision. */
export class StaleRevisionRefusal extends Schema.Error<
  StaleRevisionRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/StaleRevisionRefusal">
>("StaleRevisionRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("StaleRevision"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** The configuration revision the caller edited; a newer stored revision rejects the write. */
    expected: ConfigurationRevisionNumber,
    /** The stored revision the caller must read before retrying the edit. */
    current: ConfigurationRevisionNumber,
  },
  { httpApiStatus: 409 },
) {}

/** An HTTP 422 response with validation problems for the proposed configuration. */
export class ConfigurationInvalidRefusal extends Schema.Error<
  ConfigurationInvalidRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/ConfigurationInvalidRefusal">
>("ConfigurationInvalidRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("ConfigurationInvalid"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** Validation diagnostics grouped by configuration entity and field path. */
    problems: Schema.NonEmptyArray(
      Schema.Struct({
        entity: ConfigurationEntityKey,
        ...ConfigProblem.fields,
      }),
    ),
  },
  { httpApiStatus: 422 },
) {}

/** An HTTP 409 response when later revisions changed entities that a revert would overwrite. */
export class ConfigurationRevertRefusal extends Schema.Error<
  ConfigurationRevertRefusal,
  Brand.Brand<"@usine/orchestrator/operator/http/ConfigurationRevertRefusal">
>("ConfigurationRevertRefusal")(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("ConfigurationRevertBlocked"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** Entities modified by later revisions that prevent this revert. */
    entities: Schema.NonEmptyArray(ConfigurationEntityKey),
  },
  { httpApiStatus: 409 },
) {}

const configurationWriteErrors = [
  StaleRevisionRefusal,
  ConfigurationInvalidRefusal,
  ConfigurationRevertRefusal,
  RestartRequiredRefusal,
  ReloadPreflightRefusal,
  FactoryConfigRefusal,
  ValidationTimeoutRefusal,
];
const revisionParams = {
  number: Schema.FiniteFromString.pipe(Schema.decodeTo(ConfigurationRevisionNumber)),
};
const entityParams = ConfigurationEntityRequest.fields;

const absent = Schema.optionalKey(Schema.Never);
// Use the first occurrence of a repeated query key, as `URLSearchParams.get` did.
const queryValue = Schema.Union([
  Schema.String,
  Schema.NonEmptyArray(Schema.String).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (values) => values[0],
        encode: (value) => [value],
      }),
    ),
  ),
]);
const sequence = queryValue.pipe(
  Schema.decodeTo(Schema.FiniteFromString),
  Schema.decodeTo(TranscriptSequence),
);

// Each wire variant rules out the other cursors before decoding into the domain request. Unknown
// search keys are ignored.
const transcriptQuery = Schema.Union([
  Schema.Struct({ after: absent, before: absent, attempt: absent }).pipe(
    Schema.decodeTo(
      Schema.toType(ColdTranscriptRequest),
      SchemaTransformation.transform({
        decode: () => ColdTranscriptRequest.make(),
        encode: () => ({}),
      }),
    ),
  ),
  Schema.Struct({ after: sequence, before: absent, attempt: absent }).pipe(
    Schema.decodeTo(
      Schema.toType(TailTranscriptRequest),
      SchemaTransformation.transform({
        decode: ({ after }) => TailTranscriptRequest.make({ after }),
        encode: ({ after }) => ({ after }),
      }),
    ),
  ),
  Schema.Struct({
    after: absent,
    before: sequence,
    attempt: queryValue.pipe(Schema.decodeTo(AttemptId)),
  }).pipe(
    Schema.decodeTo(
      Schema.toType(EarlierTranscriptRequest),
      SchemaTransformation.transform({
        decode: ({ before, attempt }) =>
          EarlierTranscriptRequest.make({ before, attemptId: attempt }),
        encode: ({ before, attemptId }) => ({ before, attempt: attemptId }),
      }),
    ),
  ),
]);

const taskDescription =
  "Returns the task's items, its lane, whether it needs the operator, `runsTotal`, and its newest runs that fit 10 KB of JSON, without task prompts or result text. Read the other runs with taskRuns from offset `runs.length`, a run's prompt and transcript with detail, and an item's body and comments with item. `X-Usine-View: task` returns the first 25 runs with the comments and commit ranges of every run, and `X-Usine-View: full` returns every run with them.";

const acknowledged = Schema.Struct({ ok: Schema.Literal(true) }).annotate({
  title: "Acknowledgement",
  description: "The request was accepted. An asynchronous action may still be running.",
});
const runParams = { runId: RunId };
const loopParams = { loop: LoopName };
const statisticsQuery = Schema.Struct({
  window: queryValue.pipe(
    Schema.decodeTo(StatisticsWindow),
    Schema.withDecodingDefaultKey(Effect.succeed("30d" as const)),
  ),
});

const operatorApi = HttpApi.make("OperatorApi")
  .annotate(OpenApi.Title, "usine operator API")
  .annotate(OpenApi.Version, "unversioned")
  .annotate(
    OpenApi.Description,
    "Read instance state, manage configuration, and operate runs. Requests use instance bearer tokens or browser sessions. API paths remain under /api.",
  );

const conversationGroup = HttpApiGroup.make("conversation")
  .annotate(OpenApi.Title, "Conversations")
  .annotate(
    OpenApi.Description,
    "Members' conversations with the supervisor, and the permission requests and standing grants of its turns. A conversation is readable by every member who can read its scope; a conversation that the caller can't read is not found. Posting needs operate on the scope. Each change emits a `conversation` change notice, and each change to a standing grant or an allowed call a `permission` notice. A supervisor turn can't call any of these operations.",
  )
  .add(
    HttpApiEndpoint.get("conversationStatus", "/api/conversations/status", {
      success: ConversationStatusView,
    })
      .annotate(OpenApi.Summary, "Read the supervisor's status")
      .annotate(
        OpenApi.Description,
        "Returns `ready`, or `setup-required` with the reason, such as a host without a container runtime.",
      ),
    HttpApiEndpoint.get("conversations", "/api/conversations", {
      query: Schema.Struct({
        anchor: Schema.optionalKey(queryValue.pipe(Schema.decodeTo(AnchorKey))),
      }),
      success: ConversationsView,
    })
      .annotate(OpenApi.Summary, "List conversations")
      .annotate(
        OpenApi.Description,
        "Lists the conversations that the caller can read, latest activity first. Each has its latest turn, a preview of its latest message, and, for a member, whether it has activity they haven't read. `anchor` selects those with that anchor key: the lowercase hex SHA-256 of the JSON array `[kind, reference]`.",
      ),
    HttpApiEndpoint.post("startConversation", "/api/conversations", {
      payload: StartConversationPayload,
      success: ConversationView,
    })
      .annotate(OpenApi.Summary, "Start a conversation")
      .annotate(
        OpenApi.Description,
        "Stores the conversation with its first message and queues the turn that answers it. Needs operate on the scope and a ready supervisor.",
      ),
    HttpApiEndpoint.get("conversation", "/api/conversations/:conversation", {
      params: { conversation: ConversationId },
      success: ConversationView,
    })
      .annotate(OpenApi.Summary, "Read a conversation")
      .annotate(
        OpenApi.Description,
        "Returns the conversation with its messages, its turns, and its turns' permission requests, each with whether the caller can answer it.",
      ),
    HttpApiEndpoint.get("conversationEvents", "/api/conversations/:conversation/events", {
      params: { conversation: ConversationId },
      query: Schema.Struct({
        after: Schema.optionalKey(
          queryValue.pipe(
            Schema.decodeTo(Schema.FiniteFromString),
            Schema.decodeTo(Schema.Union([EventSequence, Schema.Literal(0)])),
          ),
        ),
      }),
      success: ConversationEventsView,
    })
      .annotate(OpenApi.Summary, "Read turn events")
      .annotate(
        OpenApi.Description,
        "Returns up to 200 session events of the conversation's turns after the sequence `after`, in order. Pass the returned `next` to read on.",
      ),
    HttpApiEndpoint.post("postMessage", "/api/conversations/:conversation/messages", {
      params: { conversation: ConversationId },
      payload: MessagePayload,
      success: PostedView,
    })
      .annotate(OpenApi.Summary, "Post a message")
      .annotate(
        OpenApi.Description,
        "Appends a member message and queues the turn that answers it, behind the conversation's earlier turns. The turn runs with the caller's access.",
      ),
    HttpApiEndpoint.post("markRead", "/api/conversations/:conversation/read", {
      params: { conversation: ConversationId },
      payload: MarkReadPayload,
      success: ReadMarkerView,
    })
      .annotate(OpenApi.Summary, "Mark a conversation read")
      .annotate(
        OpenApi.Description,
        "Marks the conversation read by the calling member through the message `through`, or through its last message if `through` is later. A marker never moves back. Needs a member credential and read on the scope. It notifies no one.",
      ),
    HttpApiEndpoint.post("cancelTurn", "/api/conversations/:conversation/turns/:turn/cancel", {
      params: { conversation: ConversationId, turn: TurnId },
      success: TurnView,
    })
      .annotate(OpenApi.Summary, "Cancel a turn")
      .annotate(
        OpenApi.Description,
        "Cancels a queued turn, or stops a running one and keeps the events it produced. Returns the turn once its end is stored.",
      ),
    HttpApiEndpoint.post(
      "answerRequest",
      "/api/conversations/:conversation/requests/:request/answer",
      {
        params: { conversation: ConversationId, request: PermissionRequestId },
        payload: AnswerPayload,
        success: PermissionRequestView,
      },
    )
      .annotate(OpenApi.Summary, "Answer a permission request")
      .annotate(
        OpenApi.Description,
        "Answers a waiting permission request of a supervisor turn with `once`, `always`, or `deny`. `once` runs the call as the caller, `always` also stores a standing grant for the operation in the call's project, and `deny` runs nothing. `always` is refused with 400 `NotGrantable` for an operation outside a project. Returns 403 when the caller's access doesn't permit the operation in its scope, and 409 `RequestAnswered` for a request that has an answer; neither changes anything. Returns the request with the outcome of the call. When every request of the turn has an answer, usine queues the turn that reports the outcomes to the supervisor.",
      ),
    HttpApiEndpoint.get("supervisorGrants", "/api/supervisor/grants", {
      success: StandingGrantsView,
    })
      .annotate(OpenApi.Summary, "List standing grants")
      .annotate(
        OpenApi.Description,
        "Lists the standing grants that aren't revoked, in projects that the caller can read, oldest first. Each says whether it applies now, and whether the caller can revoke it.",
      ),
    HttpApiEndpoint.delete("revokeSupervisorGrant", "/api/supervisor/grants/:grant", {
      params: { grant: StandingGrantId },
      success: StandingGrantView,
    })
      .annotate(OpenApi.Summary, "Revoke a standing grant")
      .annotate(
        OpenApi.Description,
        "Revokes a standing grant, so later calls of its operation in its project wait for a member again. Needs the access that the grant's operation needs in its project. Revoking a revoked grant changes nothing.",
      ),
    HttpApiEndpoint.get("supervisorActions", "/api/supervisor/actions", {
      success: SupervisorActionsView,
    })
      .annotate(OpenApi.Summary, "List the calls that supervisor turns ran")
      .annotate(
        OpenApi.Description,
        "Lists up to 100 calls that members allowed or standing grants covered, in conversations that the caller can read, latest answer first, each with the member who allowed it, the grant if any, and its outcome.",
      ),
  )
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
  .middleware(OperatorHttpPolicy);

/**
 * The operator's HTTP API contract for reads and interventions, shared by server handlers and
 * generated clients. An action's acknowledgement only means the request was accepted.
 *
 * `POST /api/workers/:worker/preflight` checks one idle worker and returns its stored
 * prerequisites, harness checks, and container limits, including failed checks with remediation.
 * It returns 409 `WorkerPreflightRejectedError` while an attempt or another preflight uses
 * that worker. The result updates configuration, overview, and desk reads without a restart.
 */
export const OperatorApi = operatorApi.add(
  HttpApiGroup.make("operator")
    .annotate(OpenApi.Title, "Operator")
    .annotate(OpenApi.Description, "Instance reads, configuration revisions, and run actions.")
    .add(
      HttpApiEndpoint.get("upgradeStatus", "/api/upgrade", { success: UpgradeView })
        .annotate(OpenApi.Summary, "Read upgrade status")
        .annotate(
          OpenApi.Description,
          "Returns the running release, available release, and upgrade progress.",
        ),
      HttpApiEndpoint.delete("cancelUpgrade", "/api/upgrade", { success: acknowledged })
        .annotate(OpenApi.Summary, "Cancel a waiting upgrade")
        .annotate(
          OpenApi.Description,
          "Cancels a pending upgrade before installation begins and resumes deferred runs.",
        ),
      HttpApiEndpoint.get("serverVersion", "/api/version", { success: Schema.String })
        .annotate(OpenApi.Summary, "Read the running release")
        .annotate(
          OpenApi.Description,
          "Public health check that returns the running release string.",
        ),
      HttpApiEndpoint.get("serverReady", "/api/ready", {
        success: acknowledged.annotate({
          title: "Readiness",
          description: "Startup recovery has finished and runtime routes are available.",
        }),
        error: Schema.Struct({
          error: Schema.Literal("Starting"),
          message: Schema.String,
        }).pipe(HttpApiSchema.status(503)),
      })
        .annotate(OpenApi.Summary, "Check startup readiness")
        .annotate(
          OpenApi.Description,
          "Public readiness check. Returns 503 with Retry-After during startup recovery and 200 after runtime routes are installed.",
        ),
      HttpApiEndpoint.post("requestUpgrade", "/api/upgrade", {
        payload: UpgradeRequest,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Request an upgrade")
        .annotate(
          OpenApi.Description,
          "Accepts an upgrade when idle or an immediate restart. Poll upgrade status for the outcome.",
        ),
      changesRead,
      workersRead,
      HttpApiEndpoint.get("overview", "/api/overview", { success: FactoryOverview })
        .annotate(OpenApi.Summary, "Read the instance overview")
        .annotate(
          OpenApi.Description,
          "Returns each project with its lanes and their card counts, the loops, the attention items, and whether the instance is set up. It has no cards, and no project runs or labels: read a lane's cards with boardLaneItems, a task with task, and the running attempts with desk. `X-Usine-View: full` returns every card, run, and label.",
        ),
      HttpApiEndpoint.post("dismissNeed", "/api/attention/dismiss", {
        payload: AttentionKey,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Dismiss an attention item")
        .annotate(
          OpenApi.Description,
          "Acknowledges the current attention item until its state changes.",
        ),
      HttpApiEndpoint.post("undoDismissNeed", "/api/attention/undo", {
        payload: AttentionKey,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Undo an attention dismissal")
        .annotate(
          OpenApi.Description,
          "Removes the acknowledgement for the supplied attention item.",
        ),
      HttpApiEndpoint.get("agents", "/api/agents", { success: Schema.Array(AgentName) })
        .annotate(OpenApi.Summary, "List agents")
        .annotate(
          OpenApi.Description,
          "Returns the names of saved agent definitions available for runs.",
        ),
      HttpApiEndpoint.post("editAndRetry", "/api/runs/:runId/edit-and-retry", {
        params: runParams,
        payload: EditAndRetry,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Edit and retry a run")
        .annotate(
          OpenApi.Description,
          "Retries a failed run with the supplied task or agent changes.",
        ),
      HttpApiEndpoint.post("runAgain", "/api/runs/:runId/run-again", {
        params: runParams,
        payload: EditAndRetry,
        success: RunAgainResult,
      })
        .annotate(OpenApi.Summary, "Run an item again")
        .annotate(
          OpenApi.Description,
          "Opens a new run for a succeeded or canceled run and returns the admission result.",
        ),
      HttpApiEndpoint.post("intervene", "/api/runs/:runId/intervene", {
        params: runParams,
        payload: SessionIntervention,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Send an operator message")
        .annotate(
          OpenApi.Description,
          "Sends a message to the selected session of a running attempt.",
        ),
      HttpApiEndpoint.post("resetCycleBudget", "/api/cycle-budgets/reset", {
        payload: Schema.Struct({ askId: CycleBudgetAskId }),
        success: CycleBudgetResetView,
      })
        .annotate(OpenApi.Summary, "Reset an item cycle budget")
        .annotate(
          OpenApi.Description,
          "Answers an open cycle budget ask and allows the item to run again. Returns the blocked CI fix events that the reset replayed; a repeated answer returns an empty list.",
        ),
      HttpApiEndpoint.get("detail", "/api/runs/:runId", {
        params: runParams,
        query: transcriptQuery,
        success: Schema.Union([RunBriefView, RunDetailView]),
      })
        .annotate(OpenApi.Summary, "Read a run")
        .annotate(
          OpenApi.Description,
          "Returns the run's brief: its state, waits, and attempts with their outcomes and failure messages, the beginnings of its task prompt, result message, and newest kept report, and its duration and usage, without the event payload or the transcript. Read an attempt's transcript with runTranscript, newest entry first, and the whole task prompt, result message, report, or event payload with runText. `X-Usine-View: full` returns the run with its prompts, event payload, and the latest transcript page; with it, use after for updates, or before and attempt together for earlier messages.",
        )
        .annotate(OpenApi.Transform, (operation) => ({
          ...operation,
          // Effect 4.0.6 omits parameters for union query schemas.
          parameters: [
            ...operation.parameters,
            ...[
              {
                name: "after",
                schema: TranscriptSequence,
                description:
                  "With `X-Usine-View: full`, return messages after this sequence. Cannot be combined with before or attempt.",
              },
              {
                name: "before",
                schema: TranscriptSequence,
                description:
                  "With `X-Usine-View: full`, return messages before this sequence. Requires attempt; cannot be combined with after.",
              },
              {
                name: "attempt",
                schema: AttemptId,
                description:
                  "With `X-Usine-View: full`, the attempt to read earlier messages from. Requires before; cannot be combined with after.",
              },
            ].map(({ name, schema, description }) => ({
              name,
              in: "query",
              required: false,
              description,
              schema: Schema.toJsonSchemaDocument(schema).schema,
            })),
          ],
        })),
      HttpApiEndpoint.get("runTranscript", "/api/runs/:runId/transcript", {
        params: runParams,
        query: {
          attempt: Schema.optionalKey(AttemptId),
          before: Schema.optionalKey(TranscriptSequence),
          offset: position,
        },
        success: RunTranscriptPageView,
      })
        .annotate(
          OpenApi.Transform,
          describeQuery(
            new Map([
              ["attempt", "The attempt whose transcript to read. Defaults to the newest attempt."],
              [
                "before",
                "Read the entries before this sequence, as `next.before` gives it. Defaults to the newest entry.",
              ],
              [
                "offset",
                "The position in the first entry's text to start from, as `next.offset` gives it. Defaults to 0.",
              ],
            ]),
          ),
        )
        .annotate(OpenApi.Summary, "Read a page of an attempt's transcript")
        .annotate(
          OpenApi.Description,
          "Returns an attempt's transcript entries newest first, each with its kind, such as `ToolFinished` or `Failed`, its session, and its payload as JSON text. A page ends before 20 KB of JSON and can end inside a long entry. Pass `next.attempt`, `next.before`, and `next.offset` to read the older entries, until `next` is null at the attempt's first entry.",
        ),
      HttpApiEndpoint.get("runText", "/api/runs/:runId/text/:part", {
        params: { runId: RunId, part: RunTextPart },
        query: { attempt: Schema.optionalKey(AttemptId), offset: position },
        success: RunTextPageView,
      })
        .annotate(
          OpenApi.Transform,
          describeQuery(
            new Map([
              [
                "attempt",
                "For `report`, the attempt whose report to read. Defaults to the newest attempt that kept one.",
              ],
              ["offset", "The position in the text to start from, as `nextOffset` gives it."],
            ]),
          ),
        )
        .annotate(OpenApi.Summary, "Read a page of a run's text")
        .annotate(
          OpenApi.Description,
          "Returns a page of one text of the run: `task`, its effective task prompt; `result`, its result message; `report`, the final report that a failed attempt kept; or `event`, the JSON text of the event that opened it. A page ends before 20 KB of JSON; pass `nextOffset` as `offset` to read on, until it is null. For an issue or pull request, item reads the current body and comments.",
        ),
      HttpApiEndpoint.get("githubChanges", "/api/runs/:runId/github-changes", {
        params: runParams,
        success: RunGitHubChangesView,
      })
        .annotate(OpenApi.Summary, "Read GitHub changes for a run")
        .annotate(OpenApi.Description, "Returns GitHub writes grouped by attempt window."),
      HttpApiEndpoint.post("approve", "/api/runs/:runId/approve", {
        params: runParams,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Approve a waiting run")
        .annotate(
          OpenApi.Description,
          "Records the signed-in member approval for a run waiting at a gate.",
        ),
      HttpApiEndpoint.post("resolveFailure", "/api/runs/:runId/resolve-failure", {
        params: runParams,
        payload: Schema.Struct({ attemptId: AttemptId }),
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Resolve a run failure")
        .annotate(
          OpenApi.Description,
          "Acknowledges the supplied failed attempt only while it remains the current failure.",
        ),
      HttpApiEndpoint.post("applyCiLabels", "/api/runs/:runId/apply-ci-labels", {
        params: runParams,
        payload: Schema.Struct({ attemptId: AttemptId }),
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Apply CI labels after CI passes")
        .annotate(
          OpenApi.Description,
          "For a run whose CI wait ended because CI on its head didn't finish, checks that CI on the same head has passed with every workflow run concluded, applies the wait's completion labels, and resolves the supplied failed attempt.",
        ),
      HttpApiEndpoint.post("retry", "/api/runs/:runId/retry", {
        params: runParams,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Retry a failed run")
        .annotate(
          OpenApi.Description,
          "Starts another attempt of a failed run with its saved definitions.",
        ),
      HttpApiEndpoint.post("cancel", "/api/runs/:runId/cancel", {
        params: runParams,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Cancel a run")
        .annotate(
          OpenApi.Description,
          "Cancels an open run and requests that any active attempt stop.",
        ),
      HttpApiEndpoint.get("project", "/api/projects/:project", {
        params: { project: ProjectId },
        success: ProjectView,
      })
        .annotate(OpenApi.Summary, "Read a project board")
        .annotate(
          OpenApi.Description,
          "Returns the project with its lanes and their card counts across member repositories, without cards, runs, or labels. Read a lane's cards with boardLaneItems. `X-Usine-View: full` returns every card, run, and label, and `X-Usine-View: board` returns the cards of every lane except the lanes of closed and merged items, which have their counts.",
        ),
      boardLaneItemsRead,
      pullRequestFilesRead,
      HttpApiEndpoint.get("projectTask", "/api/projects/:project/tasks/:item", {
        params: {
          project: ProjectId,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        query: Schema.Struct({ repository: RepositoryName }),
        success: TaskView,
      })
        .annotate(OpenApi.Summary, "Read a project task")
        .annotate(OpenApi.Description, `Reads a task of a project repository. ${taskDescription}`),
      HttpApiEndpoint.post("moveProjectItem", "/api/projects/:project/items/:item/lane", {
        params: {
          project: ProjectId,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        payload: Schema.Struct({ repository: RepositoryName, toLane: BoardLaneId }),
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Move a project item")
        .annotate(
          OpenApi.Description,
          "Changes the GitHub labels of the task current item to match the destination lane.",
        ),
      HttpApiEndpoint.post("pauseProjectLoop", "/api/loops/:project/:loop/pause", {
        params: { project: ProjectId, loop: LoopName },
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Pause a project loop")
        .annotate(
          OpenApi.Description,
          "Stops the loop from opening new runs without canceling existing runs.",
        ),
      HttpApiEndpoint.post("unpauseProjectLoop", "/api/loops/:project/:loop/unpause", {
        params: { project: ProjectId, loop: LoopName },
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Resume a project loop")
        .annotate(OpenApi.Description, "Allows the loop to open runs for matching items."),
      HttpApiEndpoint.post("moveBoardItem", "/api/projects/:owner/:repository/items/:item/lane", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        payload: Schema.Struct({ toLane: BoardLaneId }),
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Move a repository item")
        .annotate(
          OpenApi.Description,
          "Moves the item using the lanes of the project that contains its repository.",
        ),
      HttpApiEndpoint.post("runWorkerPreflight", "/api/workers/:worker/preflight", {
        params: { worker: WorkerName },
        success: WorkerPreflightView,
      })
        .annotate(OpenApi.Summary, "Run worker preflight")
        .annotate(
          OpenApi.Description,
          "Checks one idle worker and replaces its stored capability results, including failures with remediation. Returns 409 while an attempt or another preflight uses the worker.",
        ),
      HttpApiEndpoint.post("discardLeftovers", "/api/workers/:worker/discard-leftovers", {
        params: { worker: WorkerName },
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Discard worker leftovers")
        .annotate(
          OpenApi.Description,
          "Discards a removed worker only after its running attempts have ended.",
        ),
      HttpApiEndpoint.post("pause", "/api/loops/:loop/pause", {
        params: loopParams,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Pause a loop")
        .annotate(
          OpenApi.Description,
          "Accepts a qualified project/loop name, or a short name while it is unique. Encode slashes in the path segment.",
        ),
      HttpApiEndpoint.post("unpause", "/api/loops/:loop/unpause", {
        params: loopParams,
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Resume a loop")
        .annotate(
          OpenApi.Description,
          "Accepts a qualified project/loop name, or a short name while it is unique. Encode slashes in the path segment.",
        ),
    )
    .add(
      taskRunsRead,
      HttpApiEndpoint.get("task", "/api/projects/:owner/:repository/tasks/:item", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        success: TaskView,
      })
        .annotate(OpenApi.Summary, "Read a repository task")
        .annotate(OpenApi.Description, `Reads the task that contains the item. ${taskDescription}`),
      HttpApiEndpoint.get("item", "/api/projects/:owner/:repository/items/:item", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        query: { entry: position, offset: position },
        success: ItemView,
      })
        .annotate(
          OpenApi.Transform,
          describeQuery(
            new Map([
              ["entry", "The entry to start from, as `next.entry` gives it. Defaults to 0."],
              [
                "offset",
                "The position in the entry's text to start from, in UTF-16 code units, as `next.offset` gives it. Defaults to 0.",
              ],
            ]),
          ),
        )
        .annotate(OpenApi.Summary, "Read an item's body and comments")
        .annotate(
          OpenApi.Description,
          "Returns an issue or pull request of a board task as polling last stored it, with a page of its entries: the body, then the comments and reviews by time, then the review comments by thread. A page holds no more than fit 20 KB of JSON and cuts a long entry; pass `next.entry` and `next.offset` as `entry` and `offset` to read on, until `next` is null. `omitted` counts the comments and reviews that polling doesn't store; read them on GitHub at `url`.",
        ),
    )
    .add(
      HttpApiEndpoint.post("checkLoop", "/api/configuration/loops/check", {
        payload: LoopDraft,
        success: LoopCheck,
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "Check a loop definition")
        .annotate(
          OpenApi.Description,
          "Checks the proposed loop, CEL expressions, and prompt without saving a revision.",
        ),
      HttpApiEndpoint.post("previewLoop", "/api/configuration/loops/preview", {
        payload: LoopPreviewRequest,
        success: LoopPreview,
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "Preview a loop")
        .annotate(
          OpenApi.Description,
          "Evaluates the proposed loop against stored GitHub items without making GitHub requests or saving a revision.",
        ),
      HttpApiEndpoint.get("configurationHead", "/api/configuration/head", {
        success: Schema.Struct({ number: ConfigurationRevisionNumber }),
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "Read the current configuration revision")
        .annotate(
          OpenApi.Description,
          "Returns the revision number used to detect stale configuration writes.",
        ),
      HttpApiEndpoint.get("configurationWrites", "/api/configuration/writes", {
        success: Schema.Array(ConfigurationWriteProgress),
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "List running configuration saves")
        .annotate(
          OpenApi.Description,
          "Returns each configuration save that runs now, by the `save` ID that its client sent with the write and the revision it expects, with the step it runs: `wait` while another configuration change runs, then `read`, `parse`, `restart`, `coordinator-brains`, `worker-preflight`, `store`, and `apply`.",
        ),
      HttpApiEndpoint.get("configurationCapabilities", "/api/configuration/capabilities", {
        success: Schema.Struct({
          harnesses: Schema.Array(Harness),
          harnessDetails: Schema.Array(HarnessPresentation),
          efforts: Schema.Array(Effort),
        }),
      })
        .annotate(OpenApi.Summary, "List configuration capabilities")
        .annotate(OpenApi.Description, "Returns supported harnesses and reasoning efforts."),
      HttpApiEndpoint.get("configurationRepositories", "/api/configuration/repositories", {
        success: Schema.Array(RepositoryName),
      })
        .annotate(OpenApi.Summary, "List installation repositories")
        .annotate(
          OpenApi.Description,
          "Returns repositories available to the instance GitHub App installation.",
        ),
      HttpApiEndpoint.get("configurationLabels", "/api/configuration/labels/:repository", {
        params: { repository: RepositoryName },
        success: Schema.Array(RepositoryLabel),
      })
        .annotate(OpenApi.Summary, "List repository labels")
        .annotate(
          OpenApi.Description,
          "Reads live GitHub labels. Encode the repository slash in the path segment.",
        ),
      HttpApiEndpoint.get("configurationRevisions", "/api/configuration/revisions", {
        query: Schema.Struct({
          kind: Schema.optionalKey(queryValue),
          identifier: Schema.optionalKey(queryValue.pipe(Schema.decodeTo(ConfigurationEntityId))),
          before: Schema.optionalKey(
            queryValue.pipe(
              Schema.decodeTo(Schema.FiniteFromString),
              Schema.decodeTo(ConfigurationRevisionNumber),
            ),
          ),
          limit: queryValue.pipe(
            Schema.decodeTo(Schema.FiniteFromString),
            Schema.decodeTo(ConfigurationRevisionQuery.fields.limit),
            Schema.withDecodingDefaultKey(Effect.succeed("50")),
          ),
        }),
        success: ConfigurationRevisionPage,
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "List configuration revisions")
        .annotate(
          OpenApi.Description,
          "Returns a page of revisions, newest first. Pass nextBefore as before for the next page; the default limit is 50. A page ends before 20 KB of JSON, so it can hold fewer revisions than the limit.",
        ),
      HttpApiEndpoint.get("configurationRevision", "/api/configuration/revisions/:number", {
        params: revisionParams,
        success: ConfigurationRevisionView,
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "Read a configuration revision")
        .annotate(
          OpenApi.Description,
          "Returns each changed entity with its values before and after the revision.",
        ),
      HttpApiEndpoint.get("configurationEntity", "/api/configuration/entities/:kind/:identifier", {
        params: entityParams,
        success: ConfigurationEntityView,
        error: configurationWriteErrors,
      })
        .annotate(OpenApi.Summary, "Read a configuration entity")
        .annotate(
          OpenApi.Description,
          "Returns the current JSON value, export-format text, and revision number.",
        ),
      HttpApiEndpoint.put(
        "replaceConfigurationEntity",
        "/api/configuration/entities/:kind/:identifier",
        {
          params: entityParams,
          payload: ConfigurationReplacement,
          success: ConfigurationRevisionView,
          error: configurationWriteErrors,
        },
      )
        .annotate(OpenApi.Summary, "Replace a configuration entity")
        .annotate(
          OpenApi.Description,
          "Creates or replaces an entity from value or text. The expected revision rejects stale writes.",
        ),
      HttpApiEndpoint.delete(
        "deleteConfigurationEntity",
        "/api/configuration/entities/:kind/:identifier",
        {
          params: entityParams,
          payload: ConfigurationWrite,
          success: ConfigurationRevisionView,
          error: configurationWriteErrors,
        },
      )
        .annotate(OpenApi.Summary, "Delete a configuration entity")
        .annotate(OpenApi.Description, "Deletes the entity if the expected revision is current."),
      HttpApiEndpoint.post(
        "revertConfigurationRevision",
        "/api/configuration/revisions/:number/revert",
        {
          params: revisionParams,
          payload: ConfigurationWrite,
          success: ConfigurationRevisionView,
          error: configurationWriteErrors,
        },
      )
        .annotate(OpenApi.Summary, "Revert a configuration revision")
        .annotate(
          OpenApi.Description,
          "Creates a revision restoring earlier values unless later edits conflict.",
        ),
    )
    .add(
      HttpApiEndpoint.get("configuration", "/api/configuration", {
        success: Schema.Union([ConfigurationSummaryView, ConfigurationView]),
      })
        .annotate(OpenApi.Summary, "Read instance configuration")
        .annotate(
          OpenApi.Description,
          "Returns the configuration entities by kind: projects, repositories, loops with their trigger stream and pause state, agents with their harness and model, workers with their slots, label names, and settings. Prompts, personas, lanes, and preflight results are left out; read one entity with configurationEntity, with the entity's kind and its name as identifier. `X-Usine-View: full` returns the configuration as the configuration editor shows it.",
        ),
    )
    .add(
      HttpApiEndpoint.get("desk", "/api/desk", { success: DeskView })
        .annotate(OpenApi.Summary, "Read overview attention and activity")
        .annotate(
          OpenApi.Description,
          "Returns attention items, active attempts, recent runs, and worker slots. The running attempts, then the items not moving, then the last outcomes fill 20 KB of JSON; `omitted` counts the entries of each list left out. `X-Usine-View: full` returns every entry.",
        ),
    )
    .add(
      HttpApiEndpoint.get("statistics", "/api/statistics", {
        query: statisticsQuery,
        success: StatisticsView,
      })
        .annotate(OpenApi.Summary, "Read task statistics")
        .annotate(
          OpenApi.Description,
          "Aggregates task outcomes and worker utilization for the requested window, defaulting to 30d.",
        ),
      HttpApiEndpoint.get("runStatistics", "/api/statistics/runs", {
        query: statisticsQuery,
        success: RunStatisticsView,
      })
        .annotate(OpenApi.Summary, "Read run statistics")
        .annotate(
          OpenApi.Description,
          "Aggregates runs, attempts, retries, and durations for the requested window, defaulting to 30d.",
        ),
    )
    .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
    .middleware(OperatorHttpPolicy),
  conversationGroup,
);

/** Minimum route permissions; the conversation's scope is checked when it is read. */
export const conversationPermissions = {
  conversationStatus: "read",
  conversations: "read",
  startConversation: "operate",
  conversation: "read",
  conversationEvents: "read",
  postMessage: "operate",
  markRead: "read",
  cancelTurn: "operate",
  answerRequest: "operate",
  supervisorGrants: "read",
  revokeSupervisorGrant: "operate",
  supervisorActions: "read",
} as const satisfies Record<
  keyof typeof OperatorApi.groups.conversation.endpoints,
  "read" | "operate"
>;

/** Minimum route permissions; resource-specific checks run in the operator and configuration editor. */
export const operatorPermissions = {
  serverVersion: "public",
  serverReady: "public",
  upgradeStatus: "admin",
  cancelUpgrade: "admin",
  requestUpgrade: "admin",
  overview: "read",
  workers: "admin",
  changes: "read",
  project: "read",
  boardLaneItems: "read",
  projectTask: "read",
  pullRequestFiles: "read",
  task: "read",
  taskRuns: "read",
  item: "read",
  detail: "read",
  runTranscript: "read",
  runText: "read",
  githubChanges: "read",
  desk: "read",
  statistics: "read",
  runStatistics: "read",
  agents: "read",
  dismissNeed: "admin",
  undoDismissNeed: "admin",
  resetCycleBudget: "operate",
  editAndRetry: "operate",
  runAgain: "operate",
  intervene: "operate",
  approve: "operate",
  resolveFailure: "operate",
  applyCiLabels: "operate",
  retry: "operate",
  cancel: "operate",
  moveProjectItem: "operate",
  moveBoardItem: "operate",
  pauseProjectLoop: "operate",
  unpauseProjectLoop: "operate",
  pause: "operate",
  unpause: "operate",
  runWorkerPreflight: "admin",
  discardLeftovers: "admin",
  checkLoop: "maintain",
  previewLoop: "read",
  configurationCapabilities: "read",
  configurationHead: "read",
  configurationWrites: "read",
  configurationRepositories: "admin",
  configurationLabels: "read",
  configurationRevisions: "read",
  configurationRevision: "read",
  configurationEntity: "read",
  replaceConfigurationEntity: "maintain",
  deleteConfigurationEntity: "maintain",
  revertConfigurationRevision: "maintain",
  configuration: "read",
} as const satisfies Record<
  keyof typeof OperatorApi.groups.operator.endpoints,
  "public" | "read" | "operate" | "maintain" | "admin"
>;

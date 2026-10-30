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
import { Effect, Match, Record, Schema, SchemaTransformation } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi,
} from "effect/http-api";
import { RestartBlock } from "../current-instance/changes.ts";
import type { InstanceReloadError } from "../current-instance/current-instance.ts";
import { BoardLaneId } from "./board.ts";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  TailTranscriptRequest,
} from "./transcript.ts";
import { FactoryOverview } from "./overview.ts";
import { RunDetailView, EditAndRetry, SessionIntervention } from "./run.ts";
import { RunGitHubChangesView } from "./github-changes.ts";
import { TaskView } from "./task.ts";
import { ConfigurationView } from "./configuration/view.ts";
import { DeskView } from "./desk.ts";
import { RunStatisticsView, StatisticsView, StatisticsWindow } from "./statistics/view.ts";

const errorStatuses = {
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
  RunOperationRejectedError: 409,
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
  GitHubRateLimitError: 503,
} as const;

/**
 * A failed operator request. `error` is the domain failure's tag and `message` is safe to show;
 * persistence details, credentials, and defect causes are never included.
 */
export class OperatorHttpError extends Schema.Error<OperatorHttpError>(
  "@usine/orchestrator/OperatorHttpError",
)({
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
export class RestartRequiredRefusal extends Schema.Error<RestartRequiredRefusal>(
  "@usine/orchestrator/RestartRequiredRefusal",
)(
  {
    /** The fixed domain error tag that identifies this refusal. */
    error: Schema.Literal("RestartRequiredError"),
    /** The diagnostic text to show to the operator. */
    message: Schema.String,
    /** The `usine.yaml` blocks that contain the changed fields. */
    blocks: Schema.NonEmptyArray(RestartBlock),
    /**
     * The changed fields as paths into `usine.yaml`, such as `webhooks` or
     * `workers.build-1.destination`.
     */
    fields: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
  { httpApiStatus: 409 },
) {}

/** A reload refused because Worker preflight failed for the Agents and Workers it adds. */
export class ReloadPreflightRefusal extends Schema.Error<ReloadPreflightRefusal>(
  "@usine/orchestrator/ReloadPreflightRefusal",
)(
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
export class FactoryConfigRefusal extends Schema.Error<FactoryConfigRefusal>(
  "@usine/orchestrator/FactoryConfigRefusal",
)(
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

/** The reason a reload kept the running instance. */
export type ReloadRefusal = RestartRequiredRefusal | ReloadPreflightRefusal | FactoryConfigRefusal;

/** Returns the reload endpoint's refusal for `error`, with `message` for the operator. */
export const reloadRefusal = (error: InstanceReloadError, message: string): ReloadRefusal =>
  Match.valueTags(error, {
    RestartRequiredError: ({ _tag, blocks, fields }) =>
      new RestartRequiredRefusal({ error: _tag, message, blocks, fields }),
    ReloadPreflightError: ({ _tag, agents, workers, cause }) =>
      new ReloadPreflightRefusal({
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
      new FactoryConfigRefusal({ error: _tag, message, file, stage }),
  });

/** An HTTP 409 response when a configuration write uses an outdated revision. */
export class StaleRevisionRefusal extends Schema.Error<StaleRevisionRefusal>(
  "StaleRevisionRefusal",
)(
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
export class ConfigurationInvalidRefusal extends Schema.Error<ConfigurationInvalidRefusal>(
  "ConfigurationInvalidRefusal",
)(
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
export class ConfigurationRevertRefusal extends Schema.Error<ConfigurationRevertRefusal>(
  "ConfigurationRevertRefusal",
)(
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
        decode: () => new ColdTranscriptRequest(),
        encode: () => ({}),
      }),
    ),
  ),
  Schema.Struct({ after: sequence, before: absent, attempt: absent }).pipe(
    Schema.decodeTo(
      Schema.toType(TailTranscriptRequest),
      SchemaTransformation.transform({
        decode: ({ after }) => new TailTranscriptRequest({ after }),
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
          new EarlierTranscriptRequest({ before, attemptId: attempt }),
        encode: ({ before, attemptId }) => ({ before, attempt: attemptId }),
      }),
    ),
  ),
]);

const repositoryPart = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/u, { message: "Expected a repository path segment" }),
);
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
      HttpApiEndpoint.get("serverVersion", "/api/version", { success: Schema.String })
        .annotate(OpenApi.Summary, "Read the running release")
        .annotate(
          OpenApi.Description,
          "Public health check that returns the running release string.",
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
      HttpApiEndpoint.get("overview", "/api/overview", { success: FactoryOverview })
        .annotate(OpenApi.Summary, "Read the instance overview")
        .annotate(
          OpenApi.Description,
          "Returns project boards, loops, workers, and instance readiness.",
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
        success: acknowledged,
      })
        .annotate(OpenApi.Summary, "Reset an item cycle budget")
        .annotate(
          OpenApi.Description,
          "Answers an open cycle budget ask and allows the item to run again.",
        ),
      HttpApiEndpoint.get("detail", "/api/runs/:runId", {
        params: runParams,
        query: transcriptQuery,
        success: RunDetailView,
      })
        .annotate(OpenApi.Summary, "Read a run and its transcript")
        .annotate(
          OpenApi.Description,
          "Without cursors, returns the latest transcript page. Use after for updates, or before and attempt together for earlier messages.",
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
                  "Return messages after this sequence. Cannot be combined with before or attempt.",
              },
              {
                name: "before",
                schema: TranscriptSequence,
                description:
                  "Return messages before this sequence. Requires attempt; cannot be combined with after.",
              },
              {
                name: "attempt",
                schema: AttemptId,
                description:
                  "Attempt to read earlier messages from. Requires before; cannot be combined with after.",
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
          "Returns the project and its board across member repositories.",
        ),
      HttpApiEndpoint.get("projectTask", "/api/projects/:project/tasks/:item", {
        params: {
          project: ProjectId,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        query: Schema.Struct({ repository: RepositoryName }),
        success: TaskView,
      })
        .annotate(OpenApi.Summary, "Read a project task")
        .annotate(
          OpenApi.Description,
          "Returns linked issues, pull requests, and runs for an item in a project repository.",
        ),
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
      HttpApiEndpoint.get("task", "/api/projects/:owner/:repository/tasks/:item", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        success: TaskView,
      })
        .annotate(OpenApi.Summary, "Read a repository task")
        .annotate(OpenApi.Description, "Returns linked items and runs for the repository item."),
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
      HttpApiEndpoint.get("configurationCapabilities", "/api/configuration/capabilities", {
        success: Schema.Struct({
          harnesses: Schema.Array(Harness),
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
          "Returns a page of revisions, newest first. Pass nextBefore as before for the next page; the default limit is 50.",
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
      HttpApiEndpoint.get("configuration", "/api/configuration", { success: ConfigurationView })
        .annotate(OpenApi.Summary, "Read instance configuration")
        .annotate(
          OpenApi.Description,
          "Returns stored configuration for the configuration editor.",
        ),
    )
    .add(
      HttpApiEndpoint.get("desk", "/api/desk", { success: DeskView })
        .annotate(OpenApi.Summary, "Read overview attention and activity")
        .annotate(
          OpenApi.Description,
          "Returns attention items, active attempts, recent runs, and worker slots.",
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
);

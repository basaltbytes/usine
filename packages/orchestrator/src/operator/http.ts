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
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
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
  error: Schema.Literals(Record.keys(errorStatuses)),
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
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
const acknowledged = Schema.Struct({ ok: Schema.Literal(true) });
const runParams = { runId: RunId };
const loopParams = { loop: LoopName };
const statisticsQuery = Schema.Struct({
  window: queryValue.pipe(
    Schema.decodeTo(StatisticsWindow),
    Schema.withDecodingDefaultKey(Effect.succeed("30d" as const)),
  ),
});

/**
 * The operator's HTTP API contract for reads and interventions, shared by server handlers and
 * generated clients. An action's acknowledgement only means the request was accepted.
 */
export const OperatorApi = HttpApi.make("OperatorApi").add(
  HttpApiGroup.make("operator")
    .add(
      HttpApiEndpoint.get("upgradeStatus", "/api/upgrade", { success: UpgradeView }),
      HttpApiEndpoint.get("serverVersion", "/api/version", { success: Schema.String }),
      HttpApiEndpoint.post("requestUpgrade", "/api/upgrade", {
        payload: UpgradeRequest,
        success: acknowledged,
      }),
      HttpApiEndpoint.get("overview", "/api/overview", { success: FactoryOverview }),
      HttpApiEndpoint.post("dismissNeed", "/api/attention/dismiss", {
        payload: AttentionKey,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("undoDismissNeed", "/api/attention/undo", {
        payload: AttentionKey,
        success: acknowledged,
      }),
      HttpApiEndpoint.get("agents", "/api/agents", { success: Schema.Array(AgentName) }),
      HttpApiEndpoint.post("editAndRetry", "/api/runs/:runId/edit-and-retry", {
        params: runParams,
        payload: EditAndRetry,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("runAgain", "/api/runs/:runId/run-again", {
        params: runParams,
        payload: EditAndRetry,
        success: RunAgainResult,
      }),
      HttpApiEndpoint.post("intervene", "/api/runs/:runId/intervene", {
        params: runParams,
        payload: SessionIntervention,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("resetCycleBudget", "/api/cycle-budgets/reset", {
        payload: Schema.Struct({ askId: CycleBudgetAskId }),
        success: acknowledged,
      }),
      HttpApiEndpoint.get("detail", "/api/runs/:runId", {
        params: runParams,
        query: transcriptQuery,
        success: RunDetailView,
      }),
      HttpApiEndpoint.get("githubChanges", "/api/runs/:runId/github-changes", {
        params: runParams,
        success: RunGitHubChangesView,
      }),
      HttpApiEndpoint.post("approve", "/api/runs/:runId/approve", {
        params: runParams,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("resolveFailure", "/api/runs/:runId/resolve-failure", {
        params: runParams,
        payload: Schema.Struct({ attemptId: AttemptId }),
        success: acknowledged,
      }),
      HttpApiEndpoint.post("retry", "/api/runs/:runId/retry", {
        params: runParams,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("cancel", "/api/runs/:runId/cancel", {
        params: runParams,
        success: acknowledged,
      }),
      HttpApiEndpoint.get("project", "/api/projects/:project", {
        params: { project: ProjectId },
        success: ProjectView,
      }),
      HttpApiEndpoint.get("projectTask", "/api/projects/:project/tasks/:item", {
        params: {
          project: ProjectId,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        query: Schema.Struct({ repository: RepositoryName }),
        success: TaskView,
      }),
      HttpApiEndpoint.post("moveProjectItem", "/api/projects/:project/items/:item/lane", {
        params: {
          project: ProjectId,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        payload: Schema.Struct({ repository: RepositoryName, toLane: BoardLaneId }),
        success: acknowledged,
      }),
      HttpApiEndpoint.post("pauseProjectLoop", "/api/loops/:project/:loop/pause", {
        params: { project: ProjectId, loop: LoopName },
        success: acknowledged,
      }),
      HttpApiEndpoint.post("unpauseProjectLoop", "/api/loops/:project/:loop/unpause", {
        params: { project: ProjectId, loop: LoopName },
        success: acknowledged,
      }),
      HttpApiEndpoint.post("moveBoardItem", "/api/projects/:owner/:repository/items/:item/lane", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        payload: Schema.Struct({ toLane: BoardLaneId }),
        success: acknowledged,
      }),
      HttpApiEndpoint.post("discardLeftovers", "/api/workers/:worker/discard-leftovers", {
        params: { worker: WorkerName },
        success: acknowledged,
      }),
      HttpApiEndpoint.post("pause", "/api/loops/:loop/pause", {
        params: loopParams,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("unpause", "/api/loops/:loop/unpause", {
        params: loopParams,
        success: acknowledged,
      }),
    )
    .add(
      HttpApiEndpoint.get("task", "/api/projects/:owner/:repository/tasks/:item", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        success: TaskView,
      }),
    )
    .add(
      HttpApiEndpoint.post("checkLoop", "/api/configuration/loops/check", {
        payload: LoopDraft,
        success: LoopCheck,
        error: configurationWriteErrors,
      }),
      HttpApiEndpoint.post("previewLoop", "/api/configuration/loops/preview", {
        payload: LoopPreviewRequest,
        success: LoopPreview,
        error: configurationWriteErrors,
      }),
      HttpApiEndpoint.get("configurationCapabilities", "/api/configuration/capabilities", {
        success: Schema.Struct({ harnesses: Schema.Array(Harness), efforts: Schema.Array(Effort) }),
      }),
      HttpApiEndpoint.get("configurationRepositories", "/api/configuration/repositories", {
        success: Schema.Array(RepositoryName),
      }),
      HttpApiEndpoint.get("configurationLabels", "/api/configuration/labels/:repository", {
        params: { repository: RepositoryName },
        success: Schema.Array(RepositoryLabel),
      }),
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
      }),
      HttpApiEndpoint.get("configurationRevision", "/api/configuration/revisions/:number", {
        params: revisionParams,
        success: ConfigurationRevisionView,
        error: configurationWriteErrors,
      }),
      HttpApiEndpoint.get("configurationEntity", "/api/configuration/entities/:kind/:identifier", {
        params: entityParams,
        success: ConfigurationEntityView,
        error: configurationWriteErrors,
      }),
      HttpApiEndpoint.put(
        "replaceConfigurationEntity",
        "/api/configuration/entities/:kind/:identifier",
        {
          params: entityParams,
          payload: ConfigurationReplacement,
          success: ConfigurationRevisionView,
          error: configurationWriteErrors,
        },
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
      ),
      HttpApiEndpoint.post(
        "revertConfigurationRevision",
        "/api/configuration/revisions/:number/revert",
        {
          params: revisionParams,
          payload: ConfigurationWrite,
          success: ConfigurationRevisionView,
          error: configurationWriteErrors,
        },
      ),
    )
    .add(HttpApiEndpoint.get("configuration", "/api/configuration", { success: ConfigurationView }))
    .add(HttpApiEndpoint.get("desk", "/api/desk", { success: DeskView }))
    .add(
      HttpApiEndpoint.get("statistics", "/api/statistics", {
        query: statisticsQuery,
        success: StatisticsView,
      }),
      HttpApiEndpoint.get("runStatistics", "/api/statistics/runs", {
        query: statisticsQuery,
        success: RunStatisticsView,
      }),
    )
    .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
    .middleware(OperatorHttpPolicy),
);

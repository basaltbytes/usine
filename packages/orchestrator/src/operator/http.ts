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
import { Match, Record, Schema, SchemaTransformation } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi";
import { InstanceReload, RestartBlock } from "../current-instance/changes.ts";
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
import { ConfigurationView } from "./configuration.ts";
import { DeskView } from "./desk.ts";

const errorStatuses = {
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
 * An operator request that could not be fulfilled. `error` preserves the domain
 * failure's identity and `message` is safe to show to the operator; persistence
 * details, credentials, and defect causes never travel in this envelope.
 */
export class OperatorHttpError extends Schema.Error<OperatorHttpError>(
  "@usine/orchestrator/OperatorHttpError",
)({ error: Schema.Literals(Record.keys(errorStatuses)), message: Schema.String }) {
  /** The existing HTTP status associated with this refusal or failure. */
  get status() {
    return errorStatuses[this.error];
  }
}

// The established envelope uses `error` as its discriminator. Schema.Error keeps
// that wire shape while giving browser callers an Error with a validated identity.
const errors = [...new Set(Object.values(errorStatuses))].map((status) =>
  OperatorHttpError.check(Schema.makeFilter((error) => error.status === status)).annotate({
    httpApiStatus: status,
  }),
);

/**
 * Server policy for the operator transport: refuse cross-site origins before
 * decoding or executing requests, and translate failures into operator envelopes.
 * A server must supply this middleware; generated clients need no middleware layer.
 */
export class OperatorHttpPolicy extends HttpApiMiddleware.Service<OperatorHttpPolicy>()(
  "@usine/orchestrator/OperatorHttpPolicy",
  { error: errors },
) {}

/**
 * The Worker preflight failure behind a refused reload: the Worker capability
 * that is missing, the Worker operation that failed, or the repository whose
 * credential could not be obtained. What the check observed stays on the server.
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
export type ReloadPreflightFailure = typeof ReloadPreflightFailure.Type;

/**
 * A reload refused because `usine.yaml` changed in a way only a restart of
 * `usine up` applies. It keeps the operator envelope's `error` and `message`.
 */
export class RestartRequiredRefusal extends Schema.Error<RestartRequiredRefusal>(
  "@usine/orchestrator/RestartRequiredRefusal",
)(
  {
    error: Schema.Literal("RestartRequiredError"),
    message: Schema.String,
    /** The `usine.yaml` blocks the changed fields belong to. */
    blocks: Schema.NonEmptyArray(RestartBlock),
    /** The changed fields, as paths into `usine.yaml` such as `webhooks` or `workers.build-1.destination`. */
    fields: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
  { httpApiStatus: 409 },
) {}

/**
 * A reload refused because Worker preflight failed for the Agents and Workers
 * it adds. It keeps the operator envelope's `error` and `message`.
 */
export class ReloadPreflightRefusal extends Schema.Error<ReloadPreflightRefusal>(
  "@usine/orchestrator/ReloadPreflightRefusal",
)(
  {
    error: Schema.Literal("ReloadPreflightError"),
    message: Schema.String,
    /** The reloaded Agents whose brains preflight checked on every Worker. */
    agents: Schema.Array(AgentName),
    /** The Workers the reload adds or gives more slots, which preflight checked. */
    workers: Schema.Array(WorkerName),
    cause: ReloadPreflightFailure,
  },
  { httpApiStatus: 409 },
) {}

/**
 * A reload refused because `usine.yaml`, or a file it depends on, could not be
 * loaded. It keeps the operator envelope's `error` and `message`.
 */
export class FactoryConfigRefusal extends Schema.Error<FactoryConfigRefusal>(
  "@usine/orchestrator/FactoryConfigRefusal",
)(
  {
    error: Schema.Literal("FactoryConfigError"),
    message: Schema.String,
    file: InstancePath,
    stage: FileStage,
  },
  { httpApiStatus: 422 },
) {}

/** Why a reload kept the running instance, with the fields, Agents, Workers, or file it names. */
export type ReloadRefusal = RestartRequiredRefusal | ReloadPreflightRefusal | FactoryConfigRefusal;

/** The refusal the reload endpoint answers for `error`, with `message` for the operator. */
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

const absent = Schema.optionalKey(Schema.Never);
// URLSearchParams.get previously selected the first occurrence of a query key.
// Preserve that convention when HttpApi supplies repeated keys as arrays.
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

// Each wire variant rules out the other cursors before decoding into the existing
// domain request. Unknown search keys remain ignored, as in the original API.
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

/**
 * The operator's HTTP reads and interventions. Server handlers and generated
 * clients derive URLs, request codecs, successful responses, and typed failures
 * from this contract. Action acknowledgement means the request was accepted;
 * subsequent observation reports execution and GitHub polling progress. A
 * reload of the instance folder answers with what it changed, or with its
 * refusal and the fields, Agents, Workers, or file that refusal names; running a
 * Run again with the new Run or the cycle-budget Ask that blocked it. The
 * configuration read returns the instance folder as parsed, with its runtime
 * state.
 *
 * This capability is platform-free (ADRs 0012 and 0020). Library consumers can
 * continue using Operator directly without an HTTP server or client.
 */
export const OperatorApi = HttpApi.make("OperatorApi").add(
  HttpApiGroup.make("operator")
    .add(
      HttpApiEndpoint.get("overview", "/api/overview", { success: FactoryOverview }),
      HttpApiEndpoint.get("agents", "/api/agents", { success: Schema.Array(AgentName) }),
      HttpApiEndpoint.post("editAndRetry", "/api/runs/:runId/edit-and-retry", {
        params: runParams,
        payload: EditAndRetry.annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: acknowledged,
      }),
      HttpApiEndpoint.post("runAgain", "/api/runs/:runId/run-again", {
        params: runParams,
        payload: EditAndRetry.annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: RunAgainResult,
      }),
      HttpApiEndpoint.post("intervene", "/api/runs/:runId/intervene", {
        params: runParams,
        payload: SessionIntervention.annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: acknowledged,
      }),
      HttpApiEndpoint.post("resetCycleBudget", "/api/cycle-budgets/reset", {
        payload: Schema.Struct({ askId: CycleBudgetAskId }).annotate({
          parseOptions: { onExcessProperty: "error" },
        }),
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
        payload: Schema.Struct({ attemptId: AttemptId }).annotate({
          parseOptions: { onExcessProperty: "error" },
        }),
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
      HttpApiEndpoint.post("moveBoardItem", "/api/projects/:owner/:repository/items/:item/lane", {
        params: {
          owner: repositoryPart,
          repository: repositoryPart,
          item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
        },
        payload: Schema.Struct({ toLane: BoardLaneId }).annotate({
          parseOptions: { onExcessProperty: "error" },
        }),
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
      HttpApiEndpoint.post("reload", "/api/instance/reload", {
        success: InstanceReload,
        error: [RestartRequiredRefusal, ReloadPreflightRefusal, FactoryConfigRefusal],
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
    .add(HttpApiEndpoint.get("configuration", "/api/configuration", { success: ConfigurationView }))
    // The desk at `/`: Running now, Not moving, Last outcomes, Workers, and poll times.
    .add(HttpApiEndpoint.get("desk", "/api/desk", { success: DeskView }))
    .middleware(OperatorHttpPolicy),
);

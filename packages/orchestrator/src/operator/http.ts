import { AttemptId } from "@usine/core/attempt";
import { AgentName } from "@usine/core/agent";
import { CycleBudgetAskId } from "@usine/core/cycle-budget";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { TranscriptSequence } from "@usine/engine/transcript";
import { Record, Schema, SchemaTransformation } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi";
import { BoardLaneId } from "./board.ts";
import {
  ColdTranscriptRequest,
  EarlierTranscriptRequest,
  TailTranscriptRequest,
} from "./transcript.ts";
import { FactoryOverview } from "./overview.ts";
import { RunDetailView, EditAndRetry, SessionIntervention } from "./run.ts";

const errorStatuses = {
  SchemaError: 400,
  InvalidRequestError: 400,
  CrossSiteRequestError: 403,
  RunNotFoundError: 404,
  TranscriptAttemptNotFoundError: 404,
  BoardProjectNotFoundError: 404,
  BoardItemNotFoundError: 404,
  BoardLaneNotFoundError: 404,
  RunOperationRejectedError: 409,
  RunInterventionRejectedError: 409,
  RosterAgentNotFoundError: 404,
  CycleBudgetResetRejectedError: 409,
  BoardLaneReadOnlyError: 409,
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
 * subsequent observation reports execution and GitHub polling progress.
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
      HttpApiEndpoint.post("pause", "/api/loops/:loop/pause", {
        params: loopParams,
        success: acknowledged,
      }),
      HttpApiEndpoint.post("unpause", "/api/loops/:loop/unpause", {
        params: loopParams,
        success: acknowledged,
      }),
    )
    .middleware(OperatorHttpPolicy),
);

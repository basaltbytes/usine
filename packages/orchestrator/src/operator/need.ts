import { UpgradeWait } from "@usine/engine/engine";
import { CiFixRun } from "@usine/engine/run-reader";
import { ConfigFileError } from "@usine/config/file";
import { BillingPool, PoolLogin } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber } from "@usine/core/attempt";
import { LoopName } from "@usine/core/loop";
import { CycleBudgetAsk } from "@usine/core/cycle-budget";
import { EventId } from "@usine/core/event";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { type Brand, Effect, Schema } from "effect";
import { LabelPreflightFinding } from "../label-reconciler.ts";
import { RepositoryPollFailure } from "../polling-triggers.ts";
import { ScheduleFailure } from "../schedule-triggers.ts";
import { RunView } from "./run.ts";
import { FailureView } from "./attempt.ts";
import { BoardItemLink, BoardProjectionError } from "./board.ts";

/** A Run that needs operator approval before it can proceed. */
export class ApprovalNeed extends Schema.TaggedClass<
  ApprovalNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/ApprovalNeed">
>("@usine/orchestrator/ApprovalNeed")("ApprovalNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The run waiting for operator approval. */
  runId: RunId,
  /** The saved reason approval is required. */
  approvalReason: RunView.fields.approvalReason,
  /** The project-qualified loop name. */
  loop: LoopName,
  /**
   * The run's item, read from its board card or the item store. Null if no readable item is
   * available, such as for a schedule run.
   */
  item: Schema.NullOr(BoardItemLink),
}) {}

/**
 * A failed Run that needs an operator decision. After a `QuestionFailure` or `BlockedFailure`, the
 * Item's next state opens no Run of the Loop (ADR 0017).
 */
export class RunFailureNeed extends Schema.TaggedClass<
  RunFailureNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/RunFailureNeed">
>("@usine/orchestrator/RunFailureNeed")("RunFailureNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The run associated with this entry. */
  runId: RunId,
  /** The project-qualified loop name. */
  loop: LoopName,
  /** The unresolved failure from the latest failed attempt. */
  failure: FailureView,
  /**
   * The newest CI fix Run admitted for this Run's failed head, with its state, or null. It isn't
   * part of the attention revision, so a dismissed failure stays dismissed when its fix opens.
   */
  fixRun: Schema.NullOr(CiFixRun).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /**
   * The failed Attempt whose CI wait ended because CI on its head didn't finish. Once CI on that
   * head passes, applying the wait's completion labels names it. Absent for other failures.
   */
  unfinishedCiAttemptId: Schema.optionalKey(AttemptId),
}) {}

/** A repository poll failure that needs operator attention. */
export class PollFailureNeed extends Schema.TaggedClass<
  PollFailureNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/PollFailureNeed">
>("@usine/orchestrator/PollFailureNeed")("PollFailureNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The repository polling failure retained after sibling repositories continued. */
  failure: RepositoryPollFailure,
}) {}

/** A declared repository label that couldn't be created or confirmed. */
export class PreflightFindingNeed extends Schema.TaggedClass<
  PreflightFindingNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/PreflightFindingNeed">
>("@usine/orchestrator/PreflightFindingNeed")("PreflightFindingNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The declared label that could not be created. */
  finding: LabelPreflightFinding,
}) {}

/** An Item that couldn't be shown on its Board. */
export class BoardProjectionNeed extends Schema.TaggedClass<
  BoardProjectionNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/BoardProjectionNeed">
>("@usine/orchestrator/BoardProjectionNeed")("BoardProjectionNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The malformed stored item excluded from the board. */
  failure: BoardProjectionError,
}) {}

/** A schedule Loop that couldn't evaluate or submit its work. */
export class ScheduleFailureNeed extends Schema.TaggedClass<
  ScheduleFailureNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/ScheduleFailureNeed">
>("@usine/orchestrator/ScheduleFailureNeed")("ScheduleFailureNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The schedule failure retained after sibling loops continued. */
  failure: ScheduleFailure,
}) {}

/**
 * An authored file that failed to load at startup and was left out: a quarantined Loop opens no
 * Runs, and an invalid Agent isn't in the roster. A fix takes effect at the next `usine up`.
 */
export class ConfigFileNeed extends Schema.TaggedClass<
  ConfigFileNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/ConfigFileNeed">
>("@usine/orchestrator/ConfigFileNeed")("ConfigFileNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** Whether the invalid file defines a loop or an agent. */
  kind: Schema.Literals(["loop", "agent"]),
  /** The file path, parse stage, and validation diagnostic. */
  error: ConfigFileError,
}) {}

/**
 * Attempts recorded on a Worker that `usine.yaml` no longer declares, which startup doesn't
 * reconcile. Discarding their leftovers fails while `running` is above 0.
 *
 * @property _tag - The discriminator for attempts on a worker absent from configuration.
 * @property id - The attention entry identity for this removed worker.
 * @property worker - The worker no longer declared by the instance.
 * @property attempts - The number of recorded attempts that startup would otherwise reconcile.
 * @property running - The number of those attempts with no recorded outcome; at most `attempts`.
 */
export class UnconfiguredWorkerNeed extends Schema.TaggedClass<
  UnconfiguredWorkerNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/UnconfiguredWorkerNeed">
>("@usine/orchestrator/UnconfiguredWorkerNeed")(
  "UnconfiguredWorkerNeed",
  Schema.Struct({
    /** The attention entry identity used to distinguish this condition from other entries. */
    id: Schema.String,
    /** The worker name no longer declared by the instance. */
    worker: WorkerName,
    /** The number of Attempts recorded on the Worker that startup would otherwise reconcile. */
    attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The number of `attempts` with no recorded outcome yet. */
    running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }).check(
    Schema.makeFilter(({ attempts, running }) => running <= attempts, {
      message: "Expected no more open attempts than attempts",
    }),
  ),
) {}

/**
 * A closed Attempt whose parent task couldn't be confirmed stopped. It is still ending on `worker`
 * and takes one of its slots until a retried stop succeeds (#475).
 */
export class UnconfirmedStopNeed extends Schema.TaggedClass<
  UnconfirmedStopNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/UnconfirmedStopNeed">
>("@usine/orchestrator/UnconfirmedStopNeed")("UnconfirmedStopNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The run associated with this entry. */
  runId: RunId,
  /** The project-qualified loop name. */
  loop: LoopName,
  /** The one-based attempt number within the run. */
  attemptNumber: AttemptNumber,
  /** The configured worker name. */
  worker: WorkerName,
}) {}

/** A worker with running attempts that has stopped answering liveness checks. */
export class UnresponsiveWorkerNeed extends Schema.TaggedClass<
  UnresponsiveWorkerNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/UnresponsiveWorkerNeed">
>("@usine/orchestrator/UnresponsiveWorkerNeed")("UnresponsiveWorkerNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The configured worker name. */
  worker: WorkerName,
  /** The last successful worker response time as an ISO 8601 timestamp. */
  lastAnsweredAt: Schema.String,
  /**
   * The running attempts affected by the unresponsive worker, with their run and loop identities.
   */
  attempts: Schema.Array(
    Schema.Struct({
      attemptId: AttemptId,
      attemptNumber: AttemptNumber,
      runId: RunId,
      repository: RepositoryName,
      loop: LoopName,
    }),
  ).check(Schema.isMinLength(1)),
}) {}

/** An Item that stopped opening Runs until the operator resets its cycle budget. */
export class CycleBudgetNeed extends Schema.TaggedClass<
  CycleBudgetNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/CycleBudgetNeed">
>()("CycleBudgetNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The unanswered cycle-budget ask that prevents another run. */
  ask: CycleBudgetAsk,
  /**
   * The repository and item number for display, or the stored item key when it cannot be
   * decoded.
   */
  itemLabel: Schema.String,
  /** The GitHub item URL, or null when the item key cannot be decoded. */
  itemUrl: Schema.NullOr(Schema.String),
}) {}

/** The outcome of a cycle-budget reset. */
export class CycleBudgetResetView extends Schema.Class<
  CycleBudgetResetView,
  Brand.Brand<"@usine/orchestrator/operator/need/CycleBudgetResetView">
>("@usine/orchestrator/CycleBudgetResetView")({
  /** The blocked CI fix events that the reset replayed; empty when there was nothing to replay. */
  replayedCiFixEventIds: Schema.Array(EventId),
}) {}

/** A worker excluded from scheduling after its startup preflight failed. */
export class WorkerPreflightNeed extends Schema.TaggedClass<
  WorkerPreflightNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/WorkerPreflightNeed">
>("@usine/orchestrator/WorkerPreflightNeed")("WorkerPreflightNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The configured worker name. */
  worker: WorkerName,
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** A cloud quota refusal that requires a worker configuration or provider account change. */
export class WorkerQuotaNeed extends Schema.TaggedClass<
  WorkerQuotaNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/WorkerQuotaNeed">
>("@usine/orchestrator/WorkerQuotaNeed")("WorkerQuotaNeed", {
  /** The attention entry identity. */
  id: Schema.String,
  /** The worker whose provider refused machine creation. */
  worker: WorkerName,
  /** The provider's quota refusal. */
  message: Schema.String,
}) {}

/** A worker that `usine.yaml` pauses, so it takes no new attempts while its running ones finish. */
export class WorkerPausedNeed extends Schema.TaggedClass<
  WorkerPausedNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/WorkerPausedNeed">
>("@usine/orchestrator/WorkerPausedNeed")("WorkerPausedNeed", {
  /** The attention entry identity. */
  id: Schema.String,
  /** The paused worker. */
  worker: WorkerName,
}) {}

export const POOL_LIMIT_WARNING_PERCENT = 80;

/**
 * A billing pool usage window at or above 80 percent of its allowance, with its next reset time.
 */
export class PoolLimitNeed extends Schema.TaggedClass<
  PoolLimitNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/PoolLimitNeed">
>("@usine/orchestrator/PoolLimitNeed")("PoolLimitNeed", {
  /** The attention entry identity used to distinguish this condition from other entries. */
  id: Schema.String,
  /** The billing source for this usage. */
  pool: BillingPool,
  /** The provider account login, or `None` if unavailable; encoded as null. */
  login: Schema.OptionFromNullOr(PoolLogin),
  /** The provider usage window approaching or at its limit. */
  window: Schema.Literals(["primary", "secondary"]),
  /** The used share of the window allowance, as a percentage. */
  usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(POOL_LIMIT_WARNING_PERCENT)),
  /** The UTC time when the provider usage window resets. */
  resetsAt: Schema.DateTimeUtcFromString,
}) {}

export class WebhookSilenceNeed extends Schema.TaggedClass<
  WebhookSilenceNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/WebhookSilenceNeed">
>("@usine/orchestrator/WebhookSilenceNeed")("WebhookSilenceNeed", {
  id: Schema.String,
  startedAt: Schema.String,
  publicUrl: Schema.String,
}) {}

/** An upgrade has deferred runs for at least ten minutes. */
export class UpgradeDrainNeed extends Schema.TaggedClass<
  UpgradeDrainNeed,
  Brand.Brand<"@usine/orchestrator/operator/need/UpgradeDrainNeed">
>("@usine/orchestrator/UpgradeDrainNeed")("UpgradeDrainNeed", {
  id: Schema.String,
  wait: UpgradeWait,
  deferredRuns: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/** One reason the overview asks for operator attention. */
export const NeedView = Schema.Union([
  UpgradeDrainNeed,
  WebhookSilenceNeed,
  CycleBudgetNeed,
  ApprovalNeed,
  BoardProjectionNeed,
  RunFailureNeed,
  PollFailureNeed,
  PreflightFindingNeed,
  ScheduleFailureNeed,
  ConfigFileNeed,
  UnconfiguredWorkerNeed,
  UnconfirmedStopNeed,
  UnresponsiveWorkerNeed,
  WorkerPreflightNeed,
  WorkerQuotaNeed,
  WorkerPausedNeed,
  PoolLimitNeed,
]);
/** One reason the overview asks for operator attention. */
export type NeedView = typeof NeedView.Type;

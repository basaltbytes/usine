import { ChildHost } from "@usine/agents/child-host";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import { AgentFailure, AttemptFailure } from "@usine/core/attempt/failure";
import { StepResult, type StepResultFact } from "@usine/core/step/result";
import { GatewayCredentialKind, MachineId, WorkerName } from "@usine/core/worker";
import { Context, type Duration, Effect, type Option, Result, Schema } from "effect";

/** The persisted part of an Attempt's request, without `host`, `machine`, and `environment`. */
export class StoredRequest extends Schema.Class<StoredRequest>("@usine/durable/StoredRequest")({
  spec: AttemptChannel.RunSpec,
  worker: WorkerName,
  /** The absolute path of the Attempt's worktree on the Worker's machine. */
  cwd: Schema.NonEmptyString,
}) {}

export class AttemptRequest extends Schema.Class<AttemptRequest>("@usine/durable/AttemptRequest")({
  ...StoredRequest.fields,
  host: ChildHost,
  /**
   * The provider's ID of the machine that a provisioned Worker created for the Attempt, or `None`
   * on other Workers.
   */
  machine: Schema.Option(MachineId),
  /**
   * The environment variables passed to the children: the Worker's allowlisted variables plus the
   * Attempt's credential configuration (ADR 0011).
   */
  environment: Schema.Record(Schema.String, Schema.String),
  /**
   * Returns the credential kind that the Worker's Gateway injects (ADR 0027), or `None` if the
   * Worker has no Gateway or the harness uses its own login.
   */
  gatewayCredential: Schema.declare(
    (u): u is Effect.Effect<Option.Option<GatewayCredentialKind>> => Effect.isEffect(u),
    { expected: "an Effect that reads the gateway's credential kind" },
  ),
}) {}

/** The parent's final report, without the harvested commits, pull requests, and comments. */
export class AttemptReport extends Schema.Class<AttemptReport>("@usine/durable/AttemptReport")({
  message: Schema.NonEmptyString,
  /**
   * Whether the parent's last turn replied to an operator message or steer and delegated nothing
   * after it. Decodes as `false` for older reports.
   */
  answeredOperator: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/**
 * Returns the Attempt's StepResult. Fails with `AgentFailure` if `answeredOperator` is true and
 * `facts` is empty (ADR 0018).
 */
export const harvestedResult = (
  report: AttemptReport,
  facts: ReadonlyArray<StepResultFact>,
): Result.Result<StepResult, AgentFailure> =>
  report.answeredOperator && facts.length === 0
    ? Result.fail(
        new AgentFailure({
          message: `The parent ended with an answer to the operator, and the attempt produced no commit, pull request, or comment. Answer: ${report.message}`,
        }),
      )
    : Result.succeed(new StepResult({ message: report.message, facts }));

/** A successful parent report with no stored harvested result. */
export class ParentReported extends Schema.TaggedClass<ParentReported>(
  "@usine/durable/ParentReported",
)("ParentReported", {
  report: AttemptReport,
}) {}

/** A harvested result stored with `recordResult`. */
export class ResultRecorded extends Schema.TaggedClass<ResultRecorded>(
  "@usine/durable/ResultRecorded",
)("ResultRecorded", {
  result: StepResult,
}) {}

export class ParentFailed extends Schema.TaggedClass<ParentFailed>("@usine/durable/ParentFailed")(
  "ParentFailed",
  {
    /** The failure that `execute` returned. */
    failure: AttemptFailure,
  },
) {}

/** The stored state of an Attempt whose terminal envelope was relayed. */
export const FinishedAttempt = Schema.Union([ParentReported, ResultRecorded, ParentFailed]);
export type FinishedAttempt = typeof FinishedAttempt.Type;

/**
 * Runs each Attempt's Pi parent as a durable task in the orchestrator process. `execute` is
 * idempotent per Attempt ID.
 */
export class AttemptRuntime extends Context.Service<
  AttemptRuntime,
  {
    /**
     * Creates or reattaches the parent task, appends its activity to `io`, and returns its report.
     */
    readonly execute: (
      request: AttemptRequest,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<AttemptReport, AttemptFailure>;
    /**
     * Whether the Attempt is open in durable storage: true until `execute` relays the terminal
     * envelope, and false for a canceled task.
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /**
     * Returns the parent task's final state after `execute` relays the terminal envelope. Returns
     * `None` while the task runs, after `cancel`, or if the Attempt has no task.
     */
    readonly finished: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<FinishedAttempt>, AttemptFailure>;
    /** Stores the harvested result, which `finished` then returns as `ResultRecorded`. */
    readonly recordResult: (
      attemptId: AttemptId,
      result: StepResult,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Stores the runaway guard's unsupervised time so a reattached guard resumes from it (#178).
     * Ignores a value shorter than the stored one.
     */
    readonly recordUnsupervised: (
      attemptId: AttemptId,
      unsupervised: Duration.Duration,
    ) => Effect.Effect<void, AttemptFailure>;
    /** Returns the time stored by `recordUnsupervised`, or `None` if none was stored. */
    readonly unsupervised: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<Duration.Duration>, AttemptFailure>;
    /** Returns the request the task was created with, or `None` if the Attempt has no task. */
    readonly request: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<StoredRequest>, AttemptFailure>;
    /**
     * Applies an operator intervention to the live parent or a child and records it in the
     * Attempt's sink, so the sink's `append` must not wait on this call. Fails if no `execute` call
     * in this process is relaying the Attempt.
     */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Completes when an `execute` call in this process is relaying the Attempt. Never fails or
     * times out, so callers must bound it.
     */
    readonly attached: (attemptId: AttemptId) => Effect.Effect<void>;
    /** Aborts the children, then the parent conversation, and ends the pending `execute` call. */
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
    /**
     * Appends a Worker notice to the transcript. If the parent hasn't started, keeps only the
     * latest notice (and a preceding `WorkerUnresponsive`) until `Started`.
     */
    readonly notify: (
      attemptId: AttemptId,
      notice: AttemptChannel.WorkerNotice,
    ) => Effect.Effect<void>;
  }
>()("@usine/durable/AttemptRuntime") {}

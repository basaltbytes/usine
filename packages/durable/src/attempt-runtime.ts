import { ChildHost } from "@usine/agents/child-host";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import { AgentFailure, AttemptFailure } from "@usine/core/attempt/failure";
import { StepResult, type StepResultFact } from "@usine/core/step/result";
import { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Context, type Duration, Effect, type Option, Result, Schema } from "effect";

/**
 * What durable storage keeps of an Attempt's request: what identifies its
 * work. The child host and the environment describe the process that runs
 * the Attempt, so each `execute` call supplies them afresh.
 */
export class StoredRequest extends Schema.Class<StoredRequest>("@usine/durable/StoredRequest")({
  /**
   * The Attempt's launch input: its id, repository, task, Agent, and parent model and effort.
   * The parent's task and its `subagent` tool read it from durable storage, so a reattached
   * Attempt continues with the RunSpec it started with.
   */
  spec: AttemptChannel.RunSpec,
  /** The Worker whose machine has the Attempt's checkout and runs its children. */
  worker: WorkerName,
  /** Absolute path of the Attempt's worktree on the machine its children run on. */
  cwd: Schema.NonEmptyString,
}) {}

/** One Attempt's parent to run: its RunSpec, plus the checkout the parent and its children work in. */
export class AttemptRequest extends Schema.Class<AttemptRequest>("@usine/durable/AttemptRequest")({
  ...StoredRequest.fields,
  /** Where the parent's children run. */
  host: ChildHost,
  /**
   * The only process environment the parent's children and every command they
   * run may see: the Worker's allowlisted variables plus the Attempt's single-repo
   * credential configuration (ADR 0011). The orchestrator's own environment,
   * which holds the App private key, is never inherited. On a `RemoteShell`
   * host the variables are exported on top of the remote machine's own environment.
   */
  environment: Schema.Record(Schema.String, Schema.String),
  /**
   * Reads the kind of credential the Gateway in front of the Worker pays the
   * children's model requests with (ADR 0027), as the Worker's latest
   * preflight recorded it. The `subagent` tool reads it as each child starts
   * and records it on the child's session, so usage counts the child in the
   * pool that pays: a preflight while the Attempt runs applies to its next
   * child, and a child already started keeps the kind its session recorded.
   * Reads none when the children pay with their harness's own login, as on a
   * Worker without a Gateway.
   */
  gatewayCredential: Schema.declare(
    (u): u is Effect.Effect<Option.Option<GatewayCredentialKind>> => Effect.isEffect(u),
    { expected: "an Effect that reads the Gateway's credential kind" },
  ),
}) {}

/** What the parent said when it finished. Commits, pull requests, and comments are harvested by the executor afterwards. */
export class AttemptReport extends Schema.Class<AttemptReport>("@usine/durable/AttemptReport")({
  /** The parent's final message, never empty. The executor records it as the message of the Attempt's StepResult. */
  message: Schema.NonEmptyString,
  /**
   * The parent's last turn replied to an operator message or a steer, not to
   * the release guidance, and delegated nothing after it, so the message may
   * answer the operator rather than report the task. `harvestedResult` reads
   * it; reports recorded before it existed decode as false.
   */
  answeredOperator: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/**
 * The Attempt's result from the parent's report and the facts harvested from
 * its checkout. A parent whose last turn answered the operator, with no
 * commit, pull request, or comment to show for the Attempt, did not finish
 * its task: the Attempt fails with an `AgentFailure` that quotes the answer,
 * so the operator decides what happens next instead of the Run succeeding
 * (ADR 0018, amendment of 2026-10-19).
 */
export const harvestedResult = (
  report: AttemptReport,
  facts: ReadonlyArray<StepResultFact>,
): Result.Result<StepResult, AgentFailure> =>
  report.answeredOperator && facts.length === 0
    ? Result.fail(
        new AgentFailure({
          message: `The parent ended on its answer to the operator and the Attempt delivered no commit, pull request, or comment. Its answer: ${report.message}`,
        }),
      )
    : Result.succeed(new StepResult({ message: report.message, facts }));

/** The parent reported success, and no harvested result was recorded: the Attempt's checkout still has to be harvested. */
export class ParentReported extends Schema.TaggedClass<ParentReported>(
  "@usine/durable/ParentReported",
)("ParentReported", {
  /** The report the parent finished with, as `execute` returned it. */
  report: AttemptReport,
}) {}

/** The executor recorded the Attempt's harvested result with `recordResult`. */
export class ResultRecorded extends Schema.TaggedClass<ResultRecorded>(
  "@usine/durable/ResultRecorded",
)("ResultRecorded", {
  /** The harvested result the executor passed to `recordResult`: the parent's message and the facts from the checkout. */
  result: StepResult,
}) {}

/** The parent task ended with a failure. */
export class ParentFailed extends Schema.TaggedClass<ParentFailed>("@usine/durable/ParentFailed")(
  "ParentFailed",
  {
    /**
     * Why the parent task failed: the same failure `execute` returned for the Attempt, read back
     * from the task's outcome.
     */
    failure: AttemptFailure,
  },
) {}

/** What durable storage keeps of an Attempt whose parent task finished and relayed its terminal envelope. */
export const FinishedAttempt = Schema.Union([ParentReported, ResultRecorded, ParentFailed]);
export type FinishedAttempt = typeof FinishedAttempt.Type;

/**
 * Runs an Attempt's Pi parent as a durable task in the orchestrator process.
 *
 * `execute` is idempotent per Attempt id: the first call creates the task and
 * its parent conversation, a later call (after an orchestrator restart) finds
 * them in storage and waits for the same work. Everything the parent and its
 * children do reaches `io` as attempt channel envelopes in order, so the
 * transcript and the run drawer keep working unchanged.
 */
export class AttemptRuntime extends Context.Service<
  AttemptRuntime,
  {
    /** Creates or reattaches the Attempt's parent task, records its activity through `io`, and waits for its report. */
    readonly execute: (
      request: AttemptRequest,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<AttemptReport, AttemptFailure>;
    /**
     * Whether the Attempt is still open in durable storage, so a restart reattaches instead of starting over.
     * Stays true until `execute` has relayed the terminal envelope, even when the task itself finished earlier.
     * A canceled task is never live.
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /**
     * What the Attempt's parent task left once it finished and `execute` relayed its terminal envelope,
     * kept after that envelope so an orchestrator that stopped before recording the Attempt's outcome can
     * still finish it. None while the task runs or before the relay, after `cancel`, and when the Attempt has no task.
     */
    readonly finished: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<FinishedAttempt>, AttemptFailure>;
    /** Keeps the Attempt's harvested result with its durable record, so `finished` returns it once the parent's report is relayed. */
    readonly recordResult: (
      attemptId: AttemptId,
      result: StepResult,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Keeps with the Attempt's durable record the unsupervised time its
     * runaway guard has counted, so the guard of a reattachment after an
     * orchestrator restart goes on from it (#178). The kept time never goes
     * back: a shorter time than the one kept leaves it as it is.
     */
    readonly recordUnsupervised: (
      attemptId: AttemptId,
      unsupervised: Duration.Duration,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * The unsupervised time the Attempt's runaway guards kept with
     * `recordUnsupervised`; none when they kept none, as for an Attempt that
     * ran without a wall-clock ceiling.
     */
    readonly unsupervised: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<Duration.Duration>, AttemptFailure>;
    /** The request the Attempt's task was created with, read back for a reattachment; none when the Attempt has no task. */
    readonly request: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<StoredRequest>, AttemptFailure>;
    /**
     * Applies an operator action to the live parent or one of its children;
     * the result is recorded through the Attempt's sink. Fails while no
     * `execute` call in this process relays the Attempt's channel, which
     * `attached` waits for. It records the input with the envelopes the relay
     * appends, one at a time, so a sink's `append` must not wait for it.
     */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Completes once an `execute` call in this process relays the Attempt's
     * channel, so `intervene` reaches it; at once while one does. `execute`
     * first reads durable storage, so input sent as it starts, such as the
     * warning a reattached Attempt's runaway guard restores (#178), waits for
     * this. It never fails and waits as long as no `execute` call relays the
     * Attempt: callers bound it by the Attempt's own run.
     */
    readonly attached: (attemptId: AttemptId) => Effect.Effect<void>;
    /** Cancels the Attempt: aborts the task bottom-up (children, then the parent conversation) and settles `execute`. */
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
    /**
     * Records what the executor observed of the Attempt's Worker in its
     * transcript, after everything relayed before it. A notice sent before
     * `execute` starts the Attempt, or before its parent started, is kept and
     * recorded right after `Started`. Of those early notices only the latest
     * is kept, with the `WorkerUnresponsive` before a `WorkerResponsive`. They
     * are logged and dropped if the Attempt ends before its parent starts.
     */
    readonly notify: (
      attemptId: AttemptId,
      notice: AttemptChannel.WorkerNotice,
    ) => Effect.Effect<void>;
  }
>()("@usine/durable/AttemptRuntime") {}

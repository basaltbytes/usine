import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptId } from "@usine/core/attempt";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import { WorkerName } from "@usine/core/worker";
import { Context, type Effect, type Option, Schema } from "effect";

/** What durable storage keeps of an Attempt's request: all of it but the environment, which carries credentials. */
export class StoredRequest extends Schema.Class<StoredRequest>("@usine/durable/StoredRequest")({
  spec: AttemptChannel.RunSpec,
  worker: WorkerName,
  /** Absolute path of the Attempt's worktree on this machine. */
  cwd: Schema.NonEmptyString,
}) {}

/** One Attempt's parent to run: the same RunSpec the run host received, plus the checkout the parent and its children work in. */
export class AttemptRequest extends Schema.Class<AttemptRequest>("@usine/durable/AttemptRequest")({
  ...StoredRequest.fields,
  /**
   * The only process environment the parent's children and every command they
   * run may see: the Worker's allowlisted variables plus the Attempt's single-repo
   * credential configuration (ADR 0011). The orchestrator's own environment,
   * which holds the App private key, is never inherited.
   */
  environment: Schema.Record(Schema.String, Schema.String),
}) {}

/** What the parent said when it finished. Commits and pull requests are harvested by the executor afterwards. */
export class AttemptReport extends Schema.Class<AttemptReport>("@usine/durable/AttemptReport")({
  message: Schema.NonEmptyString,
}) {}

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
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /** The request the Attempt's task was created with, read back for a reattachment; none when the Attempt has no task. */
    readonly request: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<StoredRequest>, AttemptFailure>;
    /** Applies an operator action to the live parent or one of its children; the result is recorded through the Attempt's sink. */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /** Cancels the Attempt: aborts the task bottom-up (children, then the parent conversation) and settles `execute`. */
    readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
  }
>()("@usine/durable/AttemptRuntime") {}

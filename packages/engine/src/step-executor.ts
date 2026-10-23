import type { AttemptRecovery, RecoverySink } from "@usine/core/attempt/salvage";
import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptTask, type AttemptId } from "@usine/core/attempt";
import { SalvagePushed } from "@usine/core/attempt/salvage";
import { Event } from "@usine/core/event";
import { LoopPermissions } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run } from "@usine/core/run";
import { Step } from "@usine/core/step";
import { Schema, Context, Effect, type Option, type Result } from "effect";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import type { WorkerName } from "@usine/core/worker";
import type { StepResult } from "@usine/core/step/result";
import type { Submission } from "./engine/submission.ts";

/** The saved Event, effective task and Agent, and Step of one Attempt. */
export class StepExecution extends Schema.Class<StepExecution>("@usine/engine/StepExecution")({
  attempt: Attempt,
  event: Event,
  run: Run,
  step: Step,
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
  /** The Attempt's access to `repository`, from the Run's Loop (ADR 0011). */
  permissions: LoopPermissions,
  /** The newest pushed salvage of an earlier Attempt of the Run, which the checkout resumes from. */
  resume: Schema.Option(SalvagePushed),
  /** Whether to reattach to the Attempt's live parent task instead of starting it. */
  reattach: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/** A reservation of one Worker slot for an Attempt, freed by `release`. */
export interface WorkerLease {
  readonly worker: WorkerName;
  readonly release: Effect.Effect<void>;
}

/**
 * The channel sink for one execution. The executor runs `checkoutAcquired` after preparing the
 * checkout and before launching the Attempt; from then on, it salvages and releases the
 * checkout. Before that, the engine reconciles a kept checkout through `StepExecutor.recover`
 * (#180).
 */
export interface ExecutionSink extends AttemptChannel.Sink {
  readonly checkoutAcquired: Effect.Effect<void>;
}

/** The service that runs Attempts on Workers. */
export class StepExecutor extends Context.Service<
  StepExecutor,
  {
    /**
     * The configured Workers, plus each removed Worker until its last Attempt ends. The engine
     * calls `recover` only for Attempts on these Workers.
     */
    readonly workers: Effect.Effect<ReadonlyArray<WorkerName>>;
    /**
     * Returns whether the Attempt's parent task survived an orchestrator restart: it still runs,
     * or it finished and its result is still on the Worker.
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /**
     * Returns the result that an open Attempt's parent task stored before an orchestrator restart,
     * or `None` if nothing was stored.
     */
    readonly outcome: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<Result.Result<StepResult, AttemptFailure>>, AttemptFailure>;
    /**
     * Reconciles the checkout of an Attempt that no Run reattaches, recording its salvage before
     * releasing it. Stops a live parent task first, and fails, leaving the checkout, if it can't
     * confirm the stop. For an open Attempt whose parent task failed before a launch recorded it,
     * also records the comments the Attempt posted on the Run's Item.
     */
    readonly recover: <E>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
    ) => Effect.Effect<void, E | AttemptFailure>;
    /**
     * Stops the Attempt's work, including a parent task that survived a restart. Fails if the parent
     * task can't be confirmed stopped.
     */
    readonly interrupt: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
    /** Sends a non-terminal operator action to a live session of the Attempt. */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Waits for a Worker slot and returns its lease, which the caller releases. If `worker` is set,
     * waits for a slot on that Worker only (#177).
     */
    readonly reserve: (
      submission: Submission,
      worker: Option.Option<WorkerName>,
    ) => Effect.Effect<WorkerLease, AttemptFailure>;
    /**
     * Takes a slot on `worker` immediately for an Attempt that already runs there, even if no slot
     * is free, so the Worker can exceed its capacity until enough Attempts end (#177).
     */
    readonly occupy: (worker: WorkerName) => Effect.Effect<WorkerLease>;
    /**
     * Runs the reserved Attempt, or reattaches to it if `execution.reattach` is set, records channel
     * activity through `io`, and returns its result. Runs `io.checkoutAcquired` after preparing the
     * checkout, and never if preparation fails.
     */
    readonly execute: (
      execution: StepExecution,
      io: ExecutionSink,
    ) => Effect.Effect<StepResult, AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

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

/** The saved Event, effective task and Agent, and Step being tried in one Attempt. */
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
  /** What the Attempt may do to `repository`: the Run's Loop permission level (ADR 0011). */
  permissions: LoopPermissions,
  /** The newest pushed salvage of an earlier Attempt of this Run, which this Attempt's checkout resumes from. */
  resume: Schema.Option(SalvagePushed),
  /** The Attempt was open when the orchestrator stopped and its parent task is still live: execution reattaches to it instead of starting it. */
  reattach: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/** A reservation of one Worker's capacity for the length of an Attempt. Call `release` when the Attempt ends. */
export interface WorkerLease {
  readonly worker: WorkerName;
  readonly release: Effect.Effect<void>;
}

/**
 * What the engine gives one execution: the Attempt's channel sink, and
 * `checkoutAcquired`, which the executor runs once preparation holds the
 * Attempt's checkout, before it launches the Attempt. From then on the
 * executor salvages and releases that checkout when the Attempt ends. Until
 * then the engine still owns a checkout a restart kept for the Attempt's
 * reattachment: a cancel, or an execution that fails first, has the engine
 * reconcile it through `StepExecutor.recover` (#180).
 */
export interface ExecutionSink extends AttemptChannel.Sink {
  readonly checkoutAcquired: Effect.Effect<void>;
}

/** Runs one Attempt on a Worker: reserve capacity, execute the step, interrupt on cancel. */
export class StepExecutor extends Context.Service<
  StepExecutor,
  {
    /**
     * The Workers this executor runs Attempts on now: the configured ones, and
     * a Worker a reload removed until its last Attempt ends. The engine does
     * not call `recover` for an Attempt recorded on any other Worker: its
     * checkout stays where it is until that Worker is configured again or the
     * operator discards its leftovers, which the engine refuses for a Worker
     * in this list.
     */
    readonly workers: Effect.Effect<ReadonlyArray<WorkerName>>;
    /**
     * Whether the Attempt's parent task outlived an orchestrator restart, so its Run reattaches
     * it instead of opening the next Attempt: the task still runs, or it finished and its result
     * still has to be collected from the Worker.
     */
    readonly isLive: (attemptId: AttemptId) => Effect.Effect<boolean, AttemptFailure>;
    /**
     * The result an open Attempt's parent task stored before an orchestrator restart, which its
     * Run never recorded. The Run finishes the Attempt with it instead of failing it as interrupted;
     * none when nothing was stored.
     */
    readonly outcome: (
      attemptId: AttemptId,
    ) => Effect.Effect<Option.Option<Result.Result<StepResult, AttemptFailure>>, AttemptFailure>;
    /**
     * Reconciles an old checkout before new Attempts start; records its salvage before releasing
     * any work. The engine calls it only for an Attempt that no Run reattaches. At startup it
     * calls it for every persisted Attempt except an open one whose parent task `isLive` reports
     * live or whose liveness cannot be read, and a closed one whose parent task `interrupt` cannot
     * confirm stopped. It calls it for one of those later, once `interrupt` confirms that the
     * parent task stopped: for an open one, only when its Run closes the Attempt before an
     * execution ran `checkoutAcquired` for it. It stops the Attempt's parent task first if that
     * task is still live, and fails, leaving the checkout, when it cannot confirm the stop. It
     * reconciles the checkout whatever `isLive` reports. For an open Attempt whose parent task
     * failed with no launch to record it, it also records the comments the Attempt posted on its
     * Run's Item if its checkout is still on the Worker.
     */
    readonly recover: <E>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
    ) => Effect.Effect<void, E | AttemptFailure>;
    /**
     * Stops the identified Attempt's current work, including a parent task that outlived a restart
     * and was not reattached. Fails when that parent task cannot be confirmed stopped.
     */
    readonly interrupt: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
    /** Sends a nonterminal operator action to a live session in the identified Attempt. */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /**
     * Waits for Worker capacity; the returned lease must be released after execution or
     * cancellation. With `worker`, the lease comes from that Worker only, and the wait lasts until
     * one of its slots is free: the Run reattaches an open Attempt whose parent task and checkout
     * stay on that Worker (#177).
     */
    readonly reserve: (
      submission: Submission,
      worker: Option.Option<WorkerName>,
    ) => Effect.Effect<WorkerLease, AttemptFailure>;
    /**
     * Takes a slot of `worker` at once for an Attempt that already runs there, without waiting:
     * the slot counts that Attempt even when none is free, so the Worker then runs more Attempts
     * than it has slots, and takes no new one until enough of them end. At startup, before any
     * Run reserves, the engine occupies a slot for each open Attempt whose parent task may have
     * outlived the restart, so no new Attempt takes that slot while the Attempt's Run decides
     * whether to reattach it (#177). It also occupies one for each closed Attempt whose parent
     * task `interrupt` cannot confirm stopped. The engine occupies only a Worker `workers` lists.
     * It releases the returned lease when the reattached Attempt ends, or once `interrupt`
     * confirms that the parent task of an Attempt no Run reattaches stopped.
     */
    readonly occupy: (worker: WorkerName) => Effect.Effect<WorkerLease>;
    /**
     * Runs the reserved Attempt, or reattaches to it when `execution.reattach` is set, recording
     * channel activity through `io`, and waits for its result. It runs `io.checkoutAcquired` once
     * preparation holds the Attempt's checkout, and never when preparation fails.
     */
    readonly execute: (
      execution: StepExecution,
      io: ExecutionSink,
    ) => Effect.Effect<StepResult, AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptTask, type AttemptId } from "@usine/core/attempt";
import { SalvagePushed } from "@usine/core/attempt/salvage";
import { Event } from "@usine/core/event";
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

/** Runs one Attempt on a Worker: reserve capacity, execute the step, interrupt on cancel. */
export class StepExecutor extends Context.Service<
  StepExecutor,
  {
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
    /** Reconciles an old checkout before new Attempts start; records its salvage before releasing any work. */
    readonly recover: <E>(
      attempt: AttemptRecovery,
      record: (salvage: AttemptSalvage) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | AttemptFailure>;
    /** Requests that the identified Attempt stop its current work. */
    readonly interrupt: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
    /** Sends a nonterminal operator action to a live session in the identified Attempt. */
    readonly intervene: (
      attemptId: AttemptId,
      intervention: AttemptChannel.Intervention,
    ) => Effect.Effect<void, AttemptFailure>;
    /** Waits for Worker capacity; the returned lease must be released after execution or cancellation. */
    readonly reserve: (submission: Submission) => Effect.Effect<WorkerLease, AttemptFailure>;
    /** Runs the reserved Attempt, or reattaches to it when `execution.reattach` is set, recording channel activity through `io`, and waits for its result. */
    readonly execute: (
      execution: StepExecution,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<StepResult, AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

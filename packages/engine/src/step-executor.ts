import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptTask, type AttemptId } from "@usine/core/attempt";
import { Event } from "@usine/core/event";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run } from "@usine/core/run";
import { Step } from "@usine/core/step";
import { Schema, Context, Effect } from "effect";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import type { WorkerName } from "@usine/core/worker";
import type { StepResult } from "@usine/core/step/result";
import type { Submission } from "./engine/submission.ts";

/** What the engine hands a `StepExecutor` for one Attempt. */
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
    readonly interrupt: (attemptId: AttemptId) => Effect.Effect<void, AttemptFailure>;
    readonly reserve: (submission: Submission) => Effect.Effect<WorkerLease, AttemptFailure>;
    readonly execute: (
      execution: StepExecution,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<StepResult, AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

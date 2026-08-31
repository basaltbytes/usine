import type { Attempt, AttemptChannel, AttemptFailure, StepResult, Worker } from "@usine/core";
import { Context, Effect } from "effect";
import type { StepExecution, Submission } from "./model.ts";

/** A worker-capacity reservation held while one Attempt runs. */
export interface WorkerLease {
  readonly worker: Worker.Name;
  readonly release: Effect.Effect<void>;
}

/**
 * Port for one Attempt. #29 supplies the worker-backed adapter; #26 exercises
 * the durable engine against implementations of this interface.
 */
export class StepExecutor extends Context.Service<
  StepExecutor,
  {
    readonly interrupt: (
      attemptId: Attempt.AttemptId,
    ) => Effect.Effect<void, AttemptFailure.AttemptFailure>;
    readonly reserve: (
      submission: Submission,
    ) => Effect.Effect<WorkerLease, AttemptFailure.AttemptFailure>;
    readonly execute: (
      execution: StepExecution,
      io: AttemptChannel.Sink,
    ) => Effect.Effect<StepResult.StepResult, AttemptFailure.AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

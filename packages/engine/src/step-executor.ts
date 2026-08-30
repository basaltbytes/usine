import type { Attempt, AttemptChannel, AttemptFailure, StepResult, Worker } from "@usine/core";
import { Context, Effect } from "effect";
import type { StepExecution, Submission, TranscriptDirection } from "./model.ts";

/** A worker-capacity reservation held while one Attempt runs. */
export interface WorkerLease {
  readonly worker: Worker.Name;
  readonly release: Effect.Effect<void>;
}

/** The engine-owned transcript append seam exposed to an Attempt adapter. */
export interface StepIo {
  readonly append: (
    direction: TranscriptDirection,
    envelope: AttemptChannel.Envelope,
  ) => Effect.Effect<void, AttemptFailure.AttemptFailure>;
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
      io: StepIo,
    ) => Effect.Effect<StepResult.StepResult, AttemptFailure.AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

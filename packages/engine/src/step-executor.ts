import type * as AttemptChannel from "@usine/core/attempt/channel";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import type { AttemptId, WorkerName } from "@usine/core/ids";
import type { StepResult } from "@usine/core/step/result";
import { Context, Effect } from "effect";
import type { StepExecution, Submission } from "./model.ts";

/** A worker-capacity reservation held while one Attempt runs. */
export interface WorkerLease {
  readonly worker: WorkerName;
  readonly release: Effect.Effect<void>;
}

/**
 * Port for one Attempt. #29 supplies the worker-backed adapter; #26 exercises
 * the durable engine against implementations of this interface.
 */
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

import type { AttemptFailure } from "@usine/core";
import { Context, Effect } from "effect";
import type { StepExecution } from "./model.ts";

/**
 * Port for one Attempt. #29 supplies the worker-backed adapter; #26 exercises
 * the durable engine against implementations of this interface.
 */
export class StepExecutor extends Context.Service<
  StepExecutor,
  {
    readonly execute: (
      execution: StepExecution,
    ) => Effect.Effect<string, AttemptFailure.AttemptFailure>;
  }
>()("@usine/engine/StepExecutor") {}

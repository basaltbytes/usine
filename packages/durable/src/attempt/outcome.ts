import type { JsonValue } from "@earendil-works/chord";
import type { NextTaskState, TaskRecord } from "@earendil-works/pi-durable";
import {
  AgentFailure,
  AttemptFailure,
  DefectFailure,
  InfraFailure,
} from "@usine/core/attempt/failure";
import { Match, Option, Result, Schema } from "effect";
import { AttemptReport } from "../attempt-runtime.ts";
import type { AttemptResult } from "./documents.ts";

/** How an Attempt ended, as `execute` reports it. */
export type Settled = Result.Result<AttemptReport, AttemptFailure>;

const failureJson = Schema.fromJsonString(AttemptFailure);
const encodeFailure = Schema.encodeSync(failureJson);
const decodeFailure = Schema.decodeUnknownOption(failureJson);
const decodeMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }));

const failureMessage = (failure: AttemptFailure): string =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => message,
    DefectFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    RunawayFailure: ({ ceiling }) => `The runaway guard tripped its ${ceiling} ceiling`,
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `Attempt tried to spawn child ${attemptedChildren} after reaching its ${maxChildren}-child budget`,
  }) || failure._tag;

/** The task outcome that records an Attempt failure; `settledOf` reads it back. */
export const failedOutcome = (failure: AttemptFailure): NextTaskState<never, AttemptResult> => ({
  status: "terminal",
  outcome: {
    status: "failed",
    error: { message: failureMessage(failure), detail: encodeFailure(failure) },
  },
});

export const completedOutcome = (message: string): NextTaskState<never, AttemptResult> => ({
  status: "terminal",
  outcome: { status: "completed", result: { message } },
});

/** The Attempt's outcome as its task recorded it, mapped to the report or failure `execute` returns. */
export const settledOf = (task: TaskRecord<JsonValue, JsonValue, unknown>): Settled => {
  const outcome = task.state.outcome;
  if (outcome === undefined) {
    return Result.fail(
      new InfraFailure({ message: "The Attempt task is still running", cause: task.state.status }),
    );
  }
  switch (outcome.status) {
    case "completed":
      return Option.match(decodeMessage(outcome.result), {
        onNone: () =>
          Result.fail(
            new DefectFailure({
              message: "The Attempt task completed without a final message",
              cause: outcome.result,
            }),
          ),
        onSome: ({ message }) => Result.succeed(new AttemptReport({ message })),
      });
    case "failed":
      return Result.fail(
        Option.getOrElse(
          decodeFailure(outcome.error.detail),
          () => new InfraFailure({ message: outcome.error.message, cause: outcome.error }),
        ),
      );
    case "aborted":
      return Result.fail(
        new AgentFailure({ message: "The Attempt was canceled and its parent stopped" }),
      );
    case "faulted":
      return Result.fail(
        new DefectFailure({
          message: `The Attempt task faulted: ${outcome.error.message}`,
          cause: outcome.error,
        }),
      );
    case "orphaned":
      return Result.fail(
        new InfraFailure({
          message: `The Attempt task can no longer run: ${outcome.reason}`,
          cause: outcome.reason,
        }),
      );
  }
};

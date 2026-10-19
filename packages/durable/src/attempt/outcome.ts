import type { JsonValue } from "@earendil-works/chord";
import type { NextTaskState, TaskRecord } from "@earendil-works/pi-durable";
import {
  AgentFailure,
  AttemptFailure,
  DefectFailure,
  InfraFailure,
} from "@usine/core/attempt/failure";
import { StepResult } from "@usine/core/step/result";
import { Match, Option, Result, Schema } from "effect";
import {
  AttemptReport,
  type FinishedAttempt,
  ParentFailed,
  ParentReported,
  ResultRecorded,
} from "../attempt-runtime.ts";
import type { AttemptRecord, AttemptResult } from "./documents.ts";

/** How an Attempt ended, as `execute` reports it. */
export type Settled = Result.Result<AttemptReport, AttemptFailure>;

const failureJson = Schema.fromJsonString(AttemptFailure);
const encodeFailure = Schema.encodeSync(failureJson);
const decodeFailure = Schema.decodeUnknownOption(failureJson);
const decodeResult = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.NonEmptyString,
    answeredOperator: Schema.optionalKey(Schema.Boolean),
  }),
);

const failureMessage = (failure: AttemptFailure): string =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => message,
    DefectFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    BlockedFailure: ({ message }) => message,
    QuestionFailure: ({ question }) => question,
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

/** The task outcome of a parent that finished with `message`; `settledOf` reads it back as its `AttemptReport`. */
export const completedOutcome = (
  message: string,
  answeredOperator: boolean,
): NextTaskState<never, AttemptResult> => ({
  status: "terminal",
  outcome: { status: "completed", result: { message, answeredOperator } },
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
      return Option.match(decodeResult(outcome.result), {
        onNone: () =>
          Result.fail(
            new DefectFailure({
              message: "The Attempt task completed without a final message",
              cause: outcome.result,
            }),
          ),
        onSome: ({ message, answeredOperator }) =>
          Result.succeed(
            new AttemptReport({ message, answeredOperator: answeredOperator ?? false }),
          ),
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

const resultJson = Schema.fromJsonString(StepResult);

/** The harvested result as the Attempt's record keeps it. */
export const encodeResult = Schema.encodeSync(resultJson);
const decodeHarvested = Schema.decodeUnknownOption(resultJson);

/**
 * What a finished Attempt left, read from its record and its task: none until
 * its terminal envelope is relayed, and none for a canceled task. A recorded
 * result that does not decode counts as absent, so the checkout is harvested again.
 */
export const finishedOf = (
  record: Readonly<AttemptRecord>,
  task: TaskRecord<JsonValue, JsonValue, unknown>,
): Option.Option<FinishedAttempt> => {
  if (!record.terminalRelayed || task.state.outcome?.status === "aborted") return Option.none();
  return Option.some(
    Result.match(settledOf(task), {
      onFailure: (failure): FinishedAttempt => new ParentFailed({ failure }),
      onSuccess: (report) =>
        Option.match(Option.flatMap(Option.fromUndefinedOr(record.result), decodeHarvested), {
          onNone: (): FinishedAttempt => new ParentReported({ report }),
          onSome: (result) => new ResultRecorded({ result }),
        }),
    }),
  );
};

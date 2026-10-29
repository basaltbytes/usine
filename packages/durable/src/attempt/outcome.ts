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
    GitHubPushFailure: ({ message }) => message,
    InfraFailure: ({ message }) => message,
    DefectFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    BlockedFailure: ({ message }) => message,
    QuestionFailure: ({ question }) => question,
    RunawayFailure: ({ ceiling }) =>
      `The runaway guard stopped the attempt at its ${ceiling} ceiling`,
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      `The attempt requested child ${attemptedChildren}, over its budget of ${maxChildren} children`,
  }) || failure._tag;

/** Returns the terminal task state for `failure`. */
export const failedOutcome = (failure: AttemptFailure): NextTaskState<never, AttemptResult> => ({
  status: "terminal",
  outcome: {
    status: "failed",
    error: { message: failureMessage(failure), detail: encodeFailure(failure) },
  },
});

/** Returns the terminal task state for a parent that finished with `message`. */
export const completedOutcome = (
  message: string,
  answeredOperator: boolean,
): NextTaskState<never, AttemptResult> => ({
  status: "terminal",
  outcome: { status: "completed", result: { message, answeredOperator } },
});

/** Returns the report or failure recorded as the task's outcome. */
export const settledOf = (task: TaskRecord<JsonValue, JsonValue, unknown>): Settled => {
  const outcome = task.state.outcome;
  if (outcome === undefined) {
    return Result.fail(
      new InfraFailure({ message: "The attempt task is still running", cause: task.state.status }),
    );
  }
  switch (outcome.status) {
    case "completed":
      return Option.match(decodeResult(outcome.result), {
        onNone: () =>
          Result.fail(
            new DefectFailure({
              message: "The attempt task completed without a final message",
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
        new AgentFailure({ message: "The attempt was canceled, and its parent stopped" }),
      );
    case "faulted":
      return Result.fail(
        new DefectFailure({
          message: `The attempt task faulted: ${outcome.error.message}`,
          cause: outcome.error,
        }),
      );
    case "orphaned":
      return Result.fail(
        new InfraFailure({
          message: `The attempt task can no longer run: ${outcome.reason}`,
          cause: outcome.reason,
        }),
      );
  }
};

const resultJson = Schema.fromJsonString(StepResult);

/** Encodes a harvested result for `AttemptRecord.result`. */
export const encodeResult = Schema.encodeSync(resultJson);
const decodeHarvested = Schema.decodeUnknownOption(resultJson);

/**
 * Returns the final state of a finished Attempt. Returns `None` before the terminal envelope is
 * relayed or for a canceled task; a stored result that doesn't decode counts as absent.
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

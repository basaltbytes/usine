import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import { ItemContentHash } from "@usine/engine/item-projection";
import { Source } from "@usine/expression/expression-engine";
import { ChangedIssue, type ChangedItem, ChangedPullRequest } from "@usine/github/polling";
import { Effect, Option, Schema } from "effect";
import { RepositoryPollFailure } from "./cycle.ts";

/** One Loop that could not evaluate an Item: its `if:` failed, or its prompt did not render. */
export class LoopEvaluationFailure extends Schema.Class<LoopEvaluationFailure>(
  "@usine/orchestrator/LoopEvaluationFailure",
)({
  loop: LoopName,
  /** The authored part that failed: the trigger's `if:` or a prompt interpolation. */
  stage: Schema.Literals(["if", "prompt"]),
  expression: Schema.OptionFromNullOr(Source),
  errorTag: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/**
 * An Item whose latest evaluation failed for at least one Loop. The poll cursor
 * keeps it until the Item is evaluated again, so Needs you keeps showing its
 * failures, and the first poll of a new process retries it with the Loops that
 * process loaded.
 */
export class FailingItem extends Schema.Class<FailingItem>("@usine/orchestrator/FailingItem")({
  stream: Schema.Literals(["issue", "pr"]),
  number: ItemNumber,
  updatedAt: Schema.DateTimeUtcFromString,
  contentHash: ItemContentHash,
  failures: Schema.NonEmptyArray(LoopEvaluationFailure),
}) {}

/** The detection entry that fetches a failing Item again. */
export const changedItem = (failing: FailingItem): ChangedItem =>
  failing.stream === "issue"
    ? new ChangedIssue({ number: failing.number, updatedAt: failing.updatedAt })
    : new ChangedPullRequest({ number: failing.number, updatedAt: failing.updatedAt });

/** The failing Item an evaluation leaves behind, or none when every Loop evaluated. */
export const failingItem = (
  item: ChangedItem,
  contentHash: ItemContentHash,
  failures: ReadonlyArray<LoopEvaluationFailure>,
): Option.Option<FailingItem> => {
  const [first, ...rest] = failures;
  return first === undefined
    ? Option.none()
    : Option.some(
        new FailingItem({
          stream: item._tag === "ChangedIssue" ? "issue" : "pr",
          number: ItemNumber.make(item.number),
          updatedAt: item.updatedAt,
          contentHash,
          failures: [first, ...rest],
        }),
      );
};

const failedPart = (failure: LoopEvaluationFailure): string =>
  failure.stage === "if"
    ? "if:"
    : Option.match(failure.expression, {
        onNone: () => "prompt",
        onSome: (expression) => `prompt {{ ${expression} }}`,
      });

/** The Needs you entries of a failing Item, one per Loop, each naming the Loop and the Item. */
export const failingItemPollFailures = (
  repository: RepositoryName,
  failing: FailingItem,
): ReadonlyArray<RepositoryPollFailure> =>
  failing.failures.map(
    (failure) =>
      new RepositoryPollFailure({
        repository,
        errorTag: failure.errorTag,
        message: `Loop ${failure.loop}: ${failedPart(failure)} failed on ${
          failing.stream === "issue" ? "issue" : "pull request"
        } #${failing.number}: ${failure.message}`,
      }),
  );

const failuresOf = (failing: Option.Option<FailingItem>): ReadonlyArray<LoopEvaluationFailure> =>
  Option.match(failing, { onNone: () => [], onSome: ({ failures }) => failures });

const sameLoopPart = (left: LoopEvaluationFailure, right: LoopEvaluationFailure): boolean =>
  left.loop === right.loop && left.stage === right.stage;

/**
 * Logs the Loop failures of one evaluated Item once per Loop, Item and content
 * hash. `previous` is what the cursor recorded before this evaluation: a failure
 * it already holds at the same content hash logs at debug, and a Loop that
 * failed before and no longer fails logs its recovery.
 */
export const logItemEvaluation = Effect.fn("PollingTriggers.logItemEvaluation")(function* (
  repository: RepositoryName,
  item: number,
  previous: Option.Option<FailingItem>,
  current: Option.Option<FailingItem>,
) {
  yield* Effect.annotateCurrentSpan({ repository, item });
  for (const failing of Option.toArray(current)) {
    const reported = Option.match(previous, {
      onNone: () => [],
      onSome: (recorded) => (recorded.contentHash === failing.contentHash ? recorded.failures : []),
    });
    for (const failure of failing.failures) {
      const fields = {
        repository,
        item,
        contentHash: failing.contentHash,
        loop: failure.loop,
        stage: failure.stage,
        expression: Option.getOrNull(failure.expression),
        errorTag: failure.errorTag,
        message: failure.message,
      };
      if (reported.some((recorded) => sameLoopPart(recorded, failure))) {
        yield* Effect.logDebug("Loop evaluation still fails on unchanged Item content", fields);
      } else {
        yield* Effect.logError(
          "Loop evaluation failed on an Item; its other Loops and the repository's other Items continue",
          fields,
        );
      }
    }
  }
  const stillFailing = failuresOf(current);
  for (const recovered of failuresOf(previous)) {
    if (stillFailing.some((failure) => sameLoopPart(failure, recovered))) continue;
    yield* Effect.logInfo("Loop evaluation no longer fails on the Item", {
      repository,
      item,
      loop: recovered.loop,
      stage: recovered.stage,
    });
  }
});

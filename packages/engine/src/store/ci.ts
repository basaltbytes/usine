import type { TranscriptCodec } from "./transcript/codec.ts";
import type { ChangeBus } from "@usine/core/changes";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import {
  AttemptCanceled,
  AttemptFailed,
  AttemptHandedOff,
  AttemptSucceeded,
} from "@usine/core/attempt/outcome";
import type { CiResolution } from "@usine/core/ci";
import type { CommitSha } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { DateTime, Effect, Match, Option } from "effect";
import type { RunDatabase } from "../database/database.ts";
import { persistence } from "./codec.ts";
import { queriesFor, runTransaction } from "./queries/queries.ts";
import { runQueries } from "./queries/runs.ts";

/** Durable CI waits share the run transaction and keep the attempt's session end time. */
export const ciQueries = (
  database: RunDatabase["Service"],
  bus: typeof ChangeBus.Service,
  codec: TranscriptCodec["Service"],
) => {
  const { awaitingCiRuns } = runQueries(database);
  return {
    awaitingCi: Effect.gen(function* () {
      const rows = yield* awaitingCiRuns();
      return yield* Effect.forEach(rows, ({ runId }) =>
        database.transaction((transaction) => queriesFor(transaction, codec).snapshot(runId)),
      );
    }).pipe(
      persistence("read CI waits"),
      Effect.catchTags({
        RunNotFoundError: Effect.die,
        RunOperationRejectedError: Effect.die,
        RunRetryBlockedError: Effect.die,
      }),
      Effect.withSpan("RunStore.awaitingCi"),
    ),
    settleCi: Effect.fn("RunStore.settleCi")(function* (
      runId: RunId,
      head: CommitSha,
      resolution: CiResolution,
    ) {
      yield* Effect.annotateCurrentSpan({ runId, head, resolution: resolution._tag });
      return yield* runTransaction(
        database,
        bus,
        codec,
      )((queries) =>
        Effect.gen(function* () {
          const current = yield* queries.snapshot(runId);
          if (current.run.state._tag !== "AwaitingCi" || current.run.state.handoff.head !== head) {
            yield* Effect.logInfo(
              "CI observation ignored because the run no longer waits for this head",
              { runId, head },
            );
            return false;
          }
          const { handoff } = current.run.state;
          const state = Match.valueTags(resolution, {
            CiPassed: () => RunState.Succeeded.make(),
            CiPassedWithoutLabels: () => RunState.Failed.make(),
            CiFailed: () => RunState.Failed.make(),
            CiTimedOut: () => RunState.Failed.make({ unfinishedCi: Option.some(handoff) }),
            CiIncomplete: () => RunState.Failed.make({ unfinishedCi: Option.some(handoff) }),
            CiHandedOff: ({ reason, fixRunId }) =>
              RunState.HandedOff.make({
                reason,
                fixRunId,
                head,
                fixLoop: handoff.fixLoop,
              }),
            CiSuperseded: ({ head }) =>
              RunState.Canceled.make({ reason: RunState.HeadChanged.make({ head }) }),
            CiPullRequestClosed: ({ pullRequest }) =>
              RunState.Canceled.make({ reason: RunState.PullRequestClosed.make({ pullRequest }) }),
          });
          const outcome = Match.valueTags(resolution, {
            CiPassed: () => AttemptSucceeded.make(),
            CiHandedOff: () => AttemptHandedOff.make(),
            CiPassedWithoutLabels: ({ message }) =>
              AttemptFailed.make({ failure: AgentFailure.make({ message }) }),
            CiFailed: ({ message }) =>
              AttemptFailed.make({ failure: AgentFailure.make({ message }) }),
            CiTimedOut: ({ _tag, message }) =>
              AttemptFailed.make({
                failure: InfraFailure.make({
                  message,
                  cause: { resolution: _tag, pullRequest: handoff.pullRequest, head },
                }),
              }),
            CiIncomplete: ({ _tag, message }) =>
              AttemptFailed.make({
                failure: InfraFailure.make({
                  message,
                  cause: { resolution: _tag, pullRequest: handoff.pullRequest, head },
                }),
              }),
            CiSuperseded: () => AttemptCanceled.make(),
            CiPullRequestClosed: () => AttemptCanceled.make(),
          });
          yield* queries.settleCiAttempt(runId, outcome);
          const observedAt = yield* DateTime.now;
          yield* queries.updateState(runId, state, observedAt);
          yield* Effect.logInfo("CI wait settled", {
            runId,
            head,
            resolution: resolution._tag,
            state,
          });
          return true;
        }),
      );
    }, persistence("settle CI wait")),
  };
};

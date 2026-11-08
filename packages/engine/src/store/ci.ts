import type { TranscriptCodec } from "./transcript/codec.ts";
import type { ChangeBus } from "@usine/core/changes";
import { changeTransaction } from "./changes.ts";
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
import { sql } from "drizzle-orm";
import { DateTime, Effect, Match } from "effect";
import { jsonExtract } from "../database/dialect.ts";
import type { RunDatabase } from "../database/database.ts";
import { runs } from "../database/schema.ts";
import { persistence } from "./codec.ts";
import { queriesFor } from "./queries.ts";

/** Durable CI waits share the run transaction and keep the attempt's session end time. */
export const ciQueries = (
  database: RunDatabase["Service"],
  bus: typeof ChangeBus.Service,
  codec: TranscriptCodec["Service"],
) => ({
  awaitingCi: Effect.gen(function* () {
    const rows = yield* database
      .select({ runId: runs.runId })
      .from(runs)
      .where(sql`${jsonExtract(runs.stateJson, "$._tag")} = 'AwaitingCi'`)
      .execute();
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
    return yield* changeTransaction(
      database,
      bus,
    )((transaction, record) =>
      Effect.gen(function* () {
        const queries = queriesFor(transaction, codec, record);
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
          CiFailed: () => RunState.Failed.make(),
          CiTimedOut: () => RunState.Failed.make(),
          CiHandedOff: ({ reason, fixRunId }) =>
            RunState.HandedOff.make({
              reason,
              fixRunId,
              head,
              fixLoop: handoff.fixLoop,
            }),
          CiSuperseded: ({ head }) =>
            RunState.Canceled.make({ reason: RunState.HeadChanged.make({ head }) }),
        });
        const outcome = Match.valueTags(resolution, {
          CiPassed: () => AttemptSucceeded.make(),
          CiHandedOff: () => AttemptHandedOff.make(),
          CiFailed: ({ message }) =>
            AttemptFailed.make({ failure: AgentFailure.make({ message }) }),
          CiTimedOut: ({ message }) =>
            AttemptFailed.make({ failure: InfraFailure.make({ message, cause: message }) }),
          CiSuperseded: () => AttemptCanceled.make(),
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
});

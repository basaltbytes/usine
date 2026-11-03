import { AgentFailure } from "@usine/core/attempt/failure";
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
import type { RunDatabase } from "../database/database.ts";
import { runs } from "../database/schema.ts";
import { persistence } from "./codec.ts";
import { queriesFor } from "./queries.ts";

/** Durable CI waits share the run transaction and keep the attempt's session end time. */
export const ciQueries = (database: RunDatabase["Service"]) => ({
  awaitingCi: Effect.fn("RunStore.awaitingCi")(
    function* () {
      const rows = yield* database
        .select({ runId: runs.runId })
        .from(runs)
        .where(sql`json_extract(${runs.stateJson}, '$._tag') = 'AwaitingCi'`)
        .execute();
      return yield* Effect.forEach(rows, ({ runId }) =>
        database.transaction((transaction) => queriesFor(transaction).snapshot(runId)),
      );
    },
    persistence("read CI waits"),
    Effect.catchTags({
      RunNotFoundError: Effect.die,
      RunOperationRejectedError: Effect.die,
      RunRetryBlockedError: Effect.die,
    }),
  ),
  settleCi: Effect.fn("RunStore.settleCi")(function* (
    runId: RunId,
    head: CommitSha,
    resolution: CiResolution,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, head, resolution: resolution._tag });
    return yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const queries = queriesFor(transaction);
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
          CiPassed: () => new RunState.Succeeded(),
          CiFailed: () => new RunState.Failed(),
          CiHandedOff: ({ reason, fixRunId }) =>
            new RunState.HandedOff({
              reason,
              fixRunId,
              head,
              fixLoop: handoff.fixLoop,
            }),
          CiSuperseded: ({ head }) =>
            new RunState.Canceled({ reason: new RunState.HeadChanged({ head }) }),
        });
        const outcome = Match.valueTags(resolution, {
          CiPassed: () => new AttemptSucceeded(),
          CiHandedOff: () => new AttemptHandedOff(),
          CiFailed: ({ message }) => new AttemptFailed({ failure: new AgentFailure({ message }) }),
          CiSuperseded: () => new AttemptCanceled(),
        });
        yield* queries.settleCiAttempt(runId, outcome);
        yield* queries.updateState(runId, state, yield* DateTime.now);
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

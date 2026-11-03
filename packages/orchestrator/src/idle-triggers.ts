import { Effect, Layer, Option } from "effect";
import { PollCycle, PollingTriggers } from "./polling-triggers.ts";
import { ScheduleCycle, ScheduleTriggers } from "./schedule-triggers.ts";

/** Trigger services that never poll or tick, for an instance that still needs setup. */
export const idleTriggersLayer = Layer.mergeAll(
  Layer.succeed(PollingTriggers)({
    lastHint: Effect.succeedNone,
    hint: () => Effect.void,
    latest: Effect.succeedNone,
    poll: () =>
      Effect.succeed(
        PollCycle.make({
          repositories: 0,
          changedItems: 0,
          submissions: [],
          revokedRuns: 0,
          failures: [],
          preflightFindings: [],
          nextPollAt: Option.none(),
        }),
      ),
    run: () => Effect.never,
  }),
  Layer.succeed(ScheduleTriggers)({
    latest: Effect.succeedNone,
    tick: () =>
      Effect.succeed(
        ScheduleCycle.make({
          loops: 0,
          fanout: 0,
          submissions: [],
          skipped: 0,
          alreadyFired: 0,
          failures: [],
          nextTickAt: Option.none(),
        }),
      ),
    run: () => Effect.never,
  }),
);

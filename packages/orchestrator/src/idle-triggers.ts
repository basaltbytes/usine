import { Effect, Layer, Option } from "effect";
import { PollCycle, PollingTriggers } from "./polling-triggers.ts";
import { ScheduleCycle, ScheduleTriggers } from "./schedule-triggers.ts";

/** Trigger services that never poll or tick, for observing an instance that still needs setup. */
export const idleTriggersLayer = Layer.mergeAll(
  Layer.succeed(PollingTriggers)({
    latest: Effect.succeed(Option.none()),
    poll: () =>
      Effect.succeed(
        new PollCycle({
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
    latest: Effect.succeed(Option.none()),
    tick: () =>
      Effect.succeed(
        new ScheduleCycle({
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

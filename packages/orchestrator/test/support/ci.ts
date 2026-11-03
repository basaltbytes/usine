import { Effect, Layer, Option } from "effect";
import { CiMonitor } from "../../src/ci.ts";

/** Existing polling scenarios have no CI handoffs. */
export const idleCiMonitor = Layer.succeed(CiMonitor)({
  reconcile: () =>
    Effect.succeed({
      repositories: [],
      polledRepositories: [],
      failures: [],
      nextPollAt: Option.none(),
    }),
});

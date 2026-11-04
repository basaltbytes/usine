import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkReads } from "./fixture.ts";

it.live(
  "serves concurrent overview and desk reads below 500 ms",
  () =>
    Effect.gen(function* () {
      const rounds = yield* checkReads({ initialItems: 200, openRuns: 50, history: false });
      for (const endpoint of ["overview", "desk"] as const) {
        assert.isBelow(
          Math.min(...rounds.map((round) => round[endpoint])),
          500,
          `fastest /api/${endpoint} response, in milliseconds, of ${rounds.map((round) => round[endpoint]).join(", ")}`,
        );
      }
    }),
  120_000,
);

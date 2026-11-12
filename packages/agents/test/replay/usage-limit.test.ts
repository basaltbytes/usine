import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AttemptNumber, pendingProviderRetry } from "@usine/core/attempt";
import { AttemptFailed } from "@usine/core/attempt/outcome";
import { Running } from "@usine/core/run/state";
import { DateTime, Effect, Option, Schema } from "effect";
import { type AgentCapacityError, toAttemptFailure } from "../../src/runtime.ts";
import { type FixtureOptions, openFixture } from "./fixture.ts";
import { openPiFixture } from "./pi.ts";
import { runUsageLimit } from "./scenarios.ts";
import { isJsonObject, type Transcript } from "./transcript.ts";

/** The reset time that every harness's usage-limit fixture reports. */
const RESETS_AT = "2026-11-12T05:00:00.000Z";
/** When the refused attempt ends, before the reset. */
const ENDED_AT = DateTime.makeUnsafe("2026-11-12T03:00:00Z");

const mapObjects = (
  value: Schema.Json,
  rewrite: (object: Readonly<Record<string, Schema.Json>>) => Readonly<Record<string, Schema.Json>>,
): Schema.Json =>
  Schema.is(Schema.Array(Schema.Json))(value)
    ? value.map((item) => mapObjects(item, rewrite))
    : isJsonObject(value)
      ? rewrite(
          Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, mapObjects(item, rewrite)]),
          ),
        )
      : value;

/** Removes each reset time from the provider's report: rate-limit windows and Pi's stated wait. */
const withoutReset = (transcript: Transcript): Transcript => ({
  ...transcript,
  entries: transcript.entries.map((entry) =>
    entry.type === "runtime_exit"
      ? entry
      : {
          ...entry,
          payload: mapObjects(entry.payload, ({ resetsAt: _resetsAt, ...object }) =>
            Schema.is(Schema.String)(object.errorMessage)
              ? {
                  ...object,
                  errorMessage: object.errorMessage.replace(/ Try again in ~\d+ min\./u, ""),
                }
              : object,
          ),
        },
  ),
});

const usageLimit = (harness: "claude" | "codex" | "pi", options: FixtureOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (harness === "pi") {
        const fixture = yield* openPiFixture("usage-limit", options);
        const failure = yield* runUsageLimit(fixture.request).pipe(Effect.provide(fixture.backend));
        yield* fixture.save;
        return failure;
      }
      const fixture = yield* openFixture(harness, "usage-limit", "replay", options);
      const failure = yield* runUsageLimit(fixture.request).pipe(
        Effect.provide(fixture.backend),
        fixture.tape.guard,
      );
      yield* fixture.save;
      return failure;
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds"));

/** Returns when the run starts its next attempt after `failure` ends attempt 1 at `ENDED_AT`. */
const retryAt = (failure: AgentCapacityError) =>
  pendingProviderRetry(Running.make(), [
    {
      number: AttemptNumber.make(1),
      outcome: Option.some(AttemptFailed.make({ failure: toAttemptFailure(failure) })),
      endedAt: Option.some(ENDED_AT),
    },
  ]).pipe(Option.map(({ retryAt }) => DateTime.formatIso(retryAt)));

describe("recorded usage limits", () => {
  for (const harness of ["claude", "codex", "pi"] as const) {
    it.live(`${harness}: retries after the reported reset`, () =>
      Effect.gen(function* () {
        const failure = yield* usageLimit(harness, {});
        assert.deepStrictEqual(
          failure.resetsAt.pipe(Option.map(DateTime.formatIso)),
          Option.some(RESETS_AT),
        );
        assert.deepStrictEqual(retryAt(failure), Option.some(RESETS_AT));
      }),
    );

    it.live(`${harness}: waits the default capacity delay without a reset time`, () =>
      Effect.gen(function* () {
        const failure = yield* usageLimit(harness, { transform: withoutReset });
        assert.deepStrictEqual(failure.resetsAt, Option.none());
        assert.deepStrictEqual(retryAt(failure), Option.some("2026-11-12T03:02:00.000Z"));
      }),
    );
  }
});

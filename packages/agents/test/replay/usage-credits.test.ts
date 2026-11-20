import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import { DateTime, Effect, Fiber, Option, Schema, Stream } from "effect";
import { AgentCapacityError, ChildBackend, ChildRequest } from "../../src/runtime.ts";
import { openFixture } from "./fixture.ts";
import { collectLogs } from "../logs.ts";
import type { Transcript } from "./transcript.ts";

/** The reset time of the plan window that moved the fixture's request to usage credits. */
const PLAN_RESETS_AT = "2026-11-12T05:00:00.000Z";

const isCreditsReport = Schema.is(
  Schema.Struct({
    type: Schema.Literal("rate_limit_event"),
    rate_limit_info: Schema.Struct({ isUsingOverage: Schema.Literal(true) }),
  }),
);

/**
 * Drops Claude Code's output after the usage-credits report: the stopped child closes Claude Code
 * before the turn's answer arrives.
 */
const stoppedAtReport = (transcript: Transcript): Transcript => {
  const report = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && isCreditsReport(entry.payload),
  );
  assert.isAbove(report, 0, "the fixture reports a request on usage credits");
  return {
    ...transcript,
    entries: transcript.entries.filter(
      (entry, index) => index <= report || entry.type !== "emit_inbound",
    ),
  };
};

/** Replays the recorded turn whose request ran on usage credits, with `allowUsageCredits`. */
const replay = (allowUsageCredits: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* openFixture(
        "claude",
        "usage-credits",
        "replay",
        allowUsageCredits ? {} : { transform: stoppedAtReport },
      );
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const running = yield* (yield* ChildBackend).launch(
            ChildRequest.make({ ...fixture.request, allowUsageCredits }),
          );
          const events: Array<AgentSessionEvent> = [];
          const collected = yield* running.events.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.result,
            Effect.forkScoped,
          );
          const result = yield* running.result.pipe(Effect.result, Effect.timeout("30 seconds"));
          yield* Fiber.join(collected);
          return { result, events };
        }),
      ).pipe(Effect.provide(fixture.backend), fixture.tape.guard);
      yield* fixture.save;
      return outcome;
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds"));

describe("recorded usage credits", () => {
  it.live("claude: stops the child at its first request on usage credits", () =>
    Effect.gen(function* () {
      const { records, layer } = collectLogs(["Warn"]);
      const { result, events } = yield* replay(false).pipe(Effect.provide(layer));
      assert(result._tag === "Failure");
      const failure = result.failure;
      assert(Schema.is(AgentCapacityError)(failure), "usage credits end the child as at capacity");
      assert.deepStrictEqual(
        failure.resetsAt.pipe(Option.map(DateTime.formatIso)),
        Option.some(PLAN_RESETS_AT),
      );
      assert.include(failure.message, "settings.allow_usage_credits is off");
      assert(!events.some((event) => event._tag === "SessionFinished"));
      const stopped =
        "Claude child ran a request on usage credits, which its spec doesn't allow; stopping it";
      expect(
        records.filter(({ message }) => Array.isArray(message) && message[0] === stopped),
      ).toEqual([
        {
          level: "Warn",
          message: [stopped, expect.objectContaining({ resetsAt: PLAN_RESETS_AT })],
          annotations: expect.anything(),
        },
      ]);
    }),
  );

  it.live("claude: keeps the child working when the Attempt allows usage credits", () =>
    Effect.gen(function* () {
      const { result, events } = yield* replay(true);
      assert(result._tag === "Success");
      assert.include(result.success.message, "REPLAY_DONE");
      assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
    }),
  );
});

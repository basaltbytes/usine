import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ChildRequest } from "../../src/runtime.ts";
import { openFixture } from "./fixture.ts";
import { runScenario } from "./scenarios.ts";
import { Tape } from "./transcript.ts";

for (const type of ["expect_outbound", "emit_inbound"] as const)
  it.effect(`resets the replay idle deadline after ${type} progress`, () =>
    Effect.gen(function* () {
      const tape = new Tape({
        protocol: "claude-sdk",
        harnessVersion: "2.1.311",
        model: "recorded-model",
        scenario: "simple",
        environment: {},
        entries: [{ type, port: "claude:1", payload: "progress" }],
      });
      const completed = yield* Deferred.make<void>();
      const replay = yield* Deferred.await(completed).pipe(tape.guard, Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      if (type === "expect_outbound") tape.outbound("claude:1", "progress");
      else yield* Effect.promise(() => tape.read("claude:1"));
      yield* TestClock.adjust("4 seconds");
      yield* Deferred.succeed(completed, undefined);
      yield* Fiber.join(replay);
      tape.assertComplete();
    }),
  );

it.live("rejects a changed outbound request through the real adapter", () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "simple", "replay");
        yield* runScenario(
          "simple",
          ChildRequest.make({
            ...fixture.request,
            prompt: "This request differs from the recording.",
          }),
        ).pipe(Effect.provide(fixture.backend), fixture.tape.guard);
      }),
    ).pipe(Effect.exit);
    assert(Exit.isFailure(outcome));
    assert.include(Cause.pretty(outcome.cause), "outbound request differs");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "reports outbound mismatches from background transports without waiting for a timeout",
  () =>
    Effect.gen(function* () {
      for (const [provider, scenario] of [
        ["claude", "simple"],
        ["codex", "simple"],
        ["codex", "transport-loss"],
      ] as const) {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* openFixture(provider, scenario, "replay");
            fixture.tape.bind(
              provider === "codex" ? "0.0.1" : "supportedModels",
              "$CHANGED_REQUEST",
            );
            yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
          }),
        ).pipe(Effect.timeout("2 seconds"), Effect.exit);
        assert(Exit.isFailure(outcome));
        const failure = Cause.pretty(outcome.cause);
        assert.include(failure, "outbound request differs at transcript entry");
        assert.include(failure, "$CHANGED_REQUEST");
        assert.notInclude(failure, "TimeoutError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  15_000,
);

it.effect("reports the missing transcript entry when a scenario stops sending requests", () =>
  Effect.gen(function* () {
    const blocked = yield* Deferred.make<void>();
    const replay = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "interrupt-guidance", "replay");
        yield* runScenario("interrupt-guidance", fixture.request, {
          ...fixture.controls,
          releaseCommand: Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Effect.provide(fixture.backend), fixture.tape.guard);
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(blocked);
    yield* TestClock.adjust("5 seconds");
    const outcome = yield* Fiber.await(replay);
    assert(Exit.isFailure(outcome));
    const failure = Cause.pretty(outcome.cause);
    assert.include(failure, "replay idle for 5 seconds; missing requests");
    assert.include(failure, "transcript entry");
    assert.include(failure, "release-command");
    assert.notInclude(failure, "TimeoutError");
  }).pipe(Effect.provide(NodeServices.layer)),
);
